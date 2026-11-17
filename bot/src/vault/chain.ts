import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import type { Program as ProgramT } from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { isLocalCluster } from "../chain/localnet.ts";
import type { VaultParams } from "../config.ts";
import { fmtUsd, type Micros } from "../money.ts";
import { checkDraw } from "./gate.ts";
import type { Account, Activity, Booking, Result, VaultEvent, Withdrawal } from "./sim.ts";
import type { EpochBooking, GateResult, Recall, TxResult, VaultClient, VaultCrank, VaultState } from "./types.ts";
import type { MousetrapVault } from "./idl/mousetrap_vault.ts";

const { AnchorProvider, BN, BorshCoder, EventParser, Program, Wallet } = anchor;

const IDL = JSON.parse(readFileSync(new URL("./idl/mousetrap_vault.json", import.meta.url), "utf8")) as MousetrapVault;
export const PROGRAM_ID = new PublicKey(IDL.address);

const VIRTUAL_UNITS = 1_000_000;
/** Enough SOL for a staker's deposit, claims and withdrawal on devnet, with ticket rent. */
const DEVNET_FAUCET_LAMPORTS = 20_000_000;
const NAV_DOMAIN = Buffer.from("MOUSETRAP_NAV_V1");
const REASONS: Record<number, Recall["reason"]> = { 1: "sentinel", 2: "withdrawals", 3: "breaker", 4: "nav-silence" };

export function vaultPdas(programId: PublicKey = PROGRAM_ID) {
  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: pda(Buffer.from("config")),
    state: pda(Buffer.from("state")),
    authority: pda(Buffer.from("authority")),
    idle: pda(Buffer.from("idle")),
    bond: pda(Buffer.from("bond")),
    shareMint: pda(Buffer.from("shares")),
    epochRecord: (epoch: number) => pda(Buffer.from("epoch"), u64(epoch)),
    depositTicket: (owner: PublicKey, epoch: number) => pda(Buffer.from("deposit"), owner.toBuffer(), u64(epoch)),
  };
}

function u64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function i64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

/** The bytes the attestor signs; must match `attest::nav_message` in the program. */
export function navMessage(state: PublicKey, equity: number, positionsHash: Buffer, rebateTotal: number, timestamp: number): Buffer {
  return Buffer.concat([NAV_DOMAIN, state.toBuffer(), u64(equity), positionsHash, u64(rebateTotal), i64(timestamp)]);
}

export function txError(err: unknown): string {
  const e = err as { error?: { errorMessage?: string }; message?: string; logs?: string[] };
  if (e.error?.errorMessage) return e.error.errorMessage;
  const fromLogs = e.logs?.find((line) => line.includes("Error Message:"));
  if (fromLogs) return fromLogs.split("Error Message:")[1]!.trim();
  return e.message ?? String(err);
}

export type ChainVaultOptions = {
  connection: Connection;
  operator: Keypair;
  attestor: Keypair;
  sentinel?: Keypair;
  /** Owner of the Gemini destination token account: signs repayments and sweeps. */
  gemini: Keypair;
  /**
   * Localnet only. Profit made on the paper exchange has no on-chain USDC behind it, so
   * before a repayment or sweep the mint authority tops the Gemini account up to cover it.
   */
  mintAuthority?: Keypair;
  /** Test USDC the faucet tops a wallet up to. */
  faucetAmount?: Micros;
  now?: () => number;
  log?: (text: string) => void;
};

export type ChainInfo = { rpcUrl: string; programId: string; usdcMint: string; faucet: boolean };

type EpochPrice = { assets: bigint; shares: bigint };

type WalletHistory = {
  newest: string | undefined;
  deposits: { epoch: number; amount: number; at: number; sig: string }[];
  requests: { epoch: number; shares: number; at: number; sig: string }[];
  claims: { usdc: number; at: number; sig: string }[];
};

const CLAIM_WITHDRAW = IDL.instructions.find((ix) => ix.name === "claimWithdraw" || (ix.name as string) === "claim_withdraw")!.discriminator;

/** Shares minted for `amount` USDC at a settled epoch; matches `math::shares_for`. */
function sharesFor(amount: number, p: EpochPrice): number {
  return Number((BigInt(amount) * (p.shares + BigInt(VIRTUAL_UNITS))) / (p.assets + BigInt(VIRTUAL_UNITS)));
}

/** USDC paid for `shares` at a settled epoch; matches `math::assets_for`. */
function assetsFor(shares: number, p: EpochPrice): number {
  return Number((BigInt(shares) * (p.assets + BigInt(VIRTUAL_UNITS))) / (p.shares + BigInt(VIRTUAL_UNITS)));
}

function emptyAccount(): Account {
  return {
    cash: 0,
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

type Chain = {
  totalShares: number;
  pendingDeposits: number;
  pendingWithdrawShares: number;
  reservedWithdrawals: number;
  idleBalance: number;
};

/**
 * `VaultClient` and crank for the deployed escrow program. Every draw goes through
 * the program's gate; the local `checkDraw` is only a preview for the relayer and UI.
 */
export class ChainVault implements VaultClient, VaultCrank {
  readonly history: { t: number; price: number }[] = [];
  readonly bookings: Booking[] = [];
  readonly events: VaultEvent[] = [];
  readonly params: VaultParams;

  private cache: VaultState;
  private raw: Chain = { totalShares: 0, pendingDeposits: 0, pendingWithdrawShares: 0, reservedWithdrawals: 0, idleBalance: 0 };
  private readonly pda = vaultPdas();
  private readonly records = new Map<number, EpochPrice>();
  private readonly histories = new Map<string, WalletHistory>();
  private readonly parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
  private readonly accounts = new Map<string, { at: number; value: Promise<Account> }>();
  /** Public RPCs rate-limit hard, so off a local validator reads are reused for a few seconds. */
  private readonly minRefreshMs: number;
  private refreshedAt = 0;
  private inflight: Promise<VaultState> | null = null;
  private readonly now: () => number;
  private readonly log: (text: string) => void;

  private constructor(
    private readonly program: ProgramT<MousetrapVault>,
    private readonly opts: ChainVaultOptions,
    private readonly config: {
      usdcMint: PublicKey;
      geminiDestination: PublicKey;
      absoluteCap: number;
      performanceFeeBps: number;
    },
    params: VaultParams,
  ) {
    this.params = params;
    this.now = opts.now ?? Date.now;
    this.minRefreshMs = isLocalCluster(opts.connection.rpcEndpoint) ? 0 : 4_000;
    this.log = opts.log ?? (() => {});
    this.cache = {
      idle: 0,
      geminiEquity: 0,
      drawnPrincipal: 0,
      bond: 0,
      totalShares: 0,
      paused: false,
      recall: null,
      queuedWithdrawals: 0,
      navAt: 0,
      epoch: 1,
      absoluteCap: config.absoluteCap,
    };
  }

  static async connect(opts: ChainVaultOptions): Promise<ChainVault> {
    const provider = new AnchorProvider(opts.connection, new Wallet(opts.operator), { commitment: "confirmed" });
    const program = new Program<MousetrapVault>(IDL, provider);
    const pda = vaultPdas();
    const cfg = await program.account.vaultConfig.fetchNullable(pda.config);
    if (!cfg) throw new Error("The vault is not initialised on this cluster. Run `npm run localnet:setup`.");
    const p = cfg.settings.params;
    const bps = (v: number) => v / 10_000;
    const params: VaultParams = {
      bondMin: bps(p.bondMinBps),
      absoluteCap: p.absoluteCap.toNumber(),
      drawnNavMax: bps(p.drawnNavMaxBps),
      bufferRatio: bps(p.bufferBps),
      navMaxAgeMs: p.navMaxAgeSecs.toNumber() * 1000,
      healthMin: bps(p.healthMinBps),
      drawBlockHealth: bps(p.healthMinBps),
      recallHealth: bps(p.recallHealthBps),
      perDrawShare: bps(p.perDrawBps),
      recallDeadlineMs: p.recallDeadlineSecs.toNumber() * 1000,
      navSilenceMs: p.navSilenceSecs.toNumber() * 1000,
    };
    if (!cfg.settings.operator.equals(opts.operator.publicKey)) {
      throw new Error(`This key is not the vault operator (${cfg.settings.operator.toBase58()}).`);
    }
    const vault = new ChainVault(
      program,
      opts,
      {
        usdcMint: cfg.usdcMint,
        geminiDestination: cfg.settings.geminiDestination,
        absoluteCap: p.absoluteCap.toNumber(),
        performanceFeeBps: p.performanceFeeBps,
      },
      params,
    );
    await vault.refresh();
    vault.history.push({ t: vault.now(), price: vault.sharePrice() });
    return vault;
  }

  // --- views ---

  async state(): Promise<VaultState> {
    return this.recent();
  }

  snapshot(): VaultState {
    return { ...this.cache, recall: this.cache.recall ? { ...this.cache.recall } : null };
  }

  sharePrice(): number {
    return (this.cache.idle + this.cache.geminiEquity + VIRTUAL_UNITS) / (this.raw.totalShares + VIRTUAL_UNITS);
  }

  instantRoom(): Micros {
    const nav = this.cache.idle + this.cache.geminiEquity;
    return Math.max(0, this.cache.idle - this.params.bufferRatio * nav);
  }

  gate(amount: Micros = 0): GateResult {
    return checkDraw(this.cache, this.params, amount, this.now());
  }

  /** What the web app needs to build staker transactions itself. */
  get chain(): ChainInfo {
    return {
      rpcUrl: this.opts.connection.rpcEndpoint,
      programId: PROGRAM_ID.toBase58(),
      usdcMint: this.config.usdcMint.toBase58(),
      faucet: this.opts.mintAuthority != null,
    };
  }

  /**
   * A staker's position, read from the chain: wallet balances, open tickets, and the
   * wallet's own deposit and withdrawal transactions for cost basis. Stakers sign their
   * own transactions; the bot holds no staker funds.
   */
  account(wallet: string): Promise<Account> {
    const hit = this.accounts.get(wallet);
    if (hit && this.now() - hit.at < this.minRefreshMs) return hit.value;
    const value = this.loadAccount(wallet);
    this.accounts.set(wallet, { at: this.now(), value });
    value.catch(() => this.accounts.delete(wallet));
    return value;
  }

  private async loadAccount(wallet: string): Promise<Account> {
    let owner: PublicKey;
    try {
      owner = new PublicKey(wallet);
    } catch {
      return emptyAccount();
    }
    const byOwner = [{ memcmp: { offset: 8, bytes: owner.toBase58() } }];
    const [cash, shares, depositTickets, withdrawTickets, history] = await Promise.all([
      this.balance(getAssociatedTokenAddressSync(this.config.usdcMint, owner, true)),
      this.balance(getAssociatedTokenAddressSync(this.pda.shareMint, owner, true)),
      this.program.account.depositTicket.all(byOwner),
      this.program.account.withdrawTicket.all(byOwner),
      this.walletHistory(owner),
    ]);
    const epoch = this.cache.epoch;
    const price = this.sharePrice();
    const settled = async (e: number) => (e < epoch ? this.epochRecord(e) : null);
    const at = (list: { epoch: number; at: number }[], e: number) => list.find((x) => x.epoch === e)?.at ?? this.now();

    const tickets: Withdrawal[] = [];
    for (const { account: t } of depositTickets) {
      const e = t.epoch.toNumber();
      const amount = t.amount.toNumber();
      const record = await settled(e);
      const minted = record ? sharesFor(amount, record) : Math.round(amount / price);
      tickets.push({
        id: `deposit:${e}`,
        shares: minted,
        costBasis: 0,
        requestedAt: at(history.deposits, e),
        settlement: "instant",
        quoted: amount,
        usdc: record ? Math.round(minted * price) : amount,
        note: record ? "Deposit settled: claim your shares" : `Deposit: shares mint when epoch ${e} settles`,
        claimable: record != null,
      });
    }
    let openWithdrawals = 0;
    for (const { account: t } of withdrawTickets) {
      const e = t.epoch.toNumber();
      const burned = t.shares.toNumber();
      const record = await settled(e);
      const payout = record ? assetsFor(burned, record) : Math.round(burned * price);
      const claimable = record != null && payout <= this.raw.idleBalance;
      openWithdrawals += payout;
      tickets.push({
        id: `withdraw:${e}`,
        shares: burned,
        costBasis: 0,
        requestedAt: at(history.requests, e),
        settlement: claimable || !record ? "instant" : "queued",
        quoted: payout,
        usdc: payout,
        note: !record
          ? `Withdrawal: priced when epoch ${e} settles`
          : claimable
            ? "Withdrawal settled: ready to claim"
            : "Withdrawal settled: waiting for the operator to repay",
        claimable,
      });
    }

    let deposited = 0;
    for (const d of history.deposits) deposited += d.amount;
    let withdrawn = 0;
    const requested: Activity[] = [];
    for (const r of history.requests) {
      const record = await settled(r.epoch);
      const payout = record ? assetsFor(r.shares, record) : Math.round(r.shares * price);
      withdrawn += payout;
      requested.push({ id: `r-${r.sig}`, kind: "request", usdc: payout, at: r.at });
    }
    const activity: Activity[] = [
      ...history.deposits.map((d) => ({ id: `d-${d.sig}`, kind: "deposit" as const, usdc: d.amount, at: d.at })),
      ...requested,
      ...history.claims.map((c) => ({ id: `c-${c.sig}`, kind: "claim" as const, usdc: c.usdc, at: c.at })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 12);

    return {
      cash,
      shares,
      costBasis: 0,
      lifetimeDeposited: deposited,
      // Chosen so open value + tickets + realised equals value held and paid out less deposits.
      realizedYield: withdrawn - openWithdrawals - deposited,
      depositedAt: history.deposits.length > 0 ? Math.min(...history.deposits.map((d) => d.at)) : null,
      acceptedRisk: true,
      withdrawals: tickets,
      activity,
    };
  }

  /** SOL for fees and test USDC up to the faucet amount. Needs the test mint's authority. */
  async fundWallet(wallet: string): Promise<Result> {
    const { connection, operator, mintAuthority } = this.opts;
    if (!mintAuthority) return { ok: false, error: "This cluster has no test USDC faucet." };
    let owner: PublicKey;
    try {
      owner = new PublicKey(wallet);
    } catch {
      return { ok: false, error: "Not a Solana address." };
    }
    try {
      const sol = await connection.getBalance(owner);
      if (isLocalCluster(connection.rpcEndpoint)) {
        if (sol < LAMPORTS_PER_SOL) {
          const sig = await connection.requestAirdrop(owner, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, "confirmed");
        }
      } else if (sol < DEVNET_FAUCET_LAMPORTS / 2) {
        // Devnet rate-limits airdrops: the operator pays for a few transactions instead.
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: owner, lamports: DEVNET_FAUCET_LAMPORTS - sol }),
        );
        await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
      }
      const ata = await getOrCreateAssociatedTokenAccount(connection, operator, this.config.usdcMint, owner, true);
      const top = (this.opts.faucetAmount ?? 25_000 * 1_000_000) - Number(ata.amount);
      if (top > 0) await mintTo(connection, operator, this.config.usdcMint, ata.address, mintAuthority, top);
      this.accounts.delete(wallet);
      this.event("faucet", `Faucet sent test USDC to ${wallet.slice(0, 4)}…${wallet.slice(-4)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: txError(err) };
    }
  }

  async deposit(): Promise<Result> {
    return { ok: false, error: "The vault is on-chain: deposit from your wallet." };
  }

  async requestWithdraw(): Promise<Result<{ settlement: "instant" | "queued" }>> {
    return { ok: false, error: "The vault is on-chain: withdraw from your wallet." };
  }

  async claimWithdraw(): Promise<Result> {
    return { ok: false, error: "The vault is on-chain: claim from your wallet." };
  }

  // --- operator and relayer ---

  async previewDraw(amount: Micros): Promise<GateResult> {
    await this.recent();
    return this.gate(amount);
  }

  async requestDraw(amount: Micros, _categories: string[]): Promise<TxResult> {
    if (!(amount > 0)) return { ok: false, error: "Draw must be positive." };
    return this.send(`Draw of ${fmtUsd(amount)}`, "draw", () =>
      this.program.methods
        .requestDraw(new BN(Math.floor(amount)), 0)
        .accountsPartial({
          operator: this.opts.operator.publicKey,
          config: this.pda.config,
          state: this.pda.state,
          idleVault: this.pda.idle,
          bondVault: this.pda.bond,
          geminiDestination: this.config.geminiDestination,
          authority: this.pda.authority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
    );
  }

  async repay(amount: Micros): Promise<TxResult> {
    return this.returnFunds("repay", amount);
  }

  async sweepProfit(amount: Micros): Promise<TxResult> {
    return this.returnFunds("sweep", amount);
  }

  // --- attestor and crank ---

  async submitNav(equity: Micros): Promise<void> {
    await this.refresh();
    const timestamp = Math.max(await this.chainTime(), Math.floor(this.cache.navAt / 1000) + 1);
    const value = Math.max(0, Math.floor(equity));
    const positionsHash = createHash("sha256").update(`equity:${value}`).digest();
    const message = navMessage(this.pda.state, value, positionsHash, 0, timestamp);
    const signature = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: this.opts.attestor.secretKey,
      message,
    });
    const result = await this.send(null, "nav", () =>
      this.program.methods
        .submitNav({
          equity: new BN(value),
          positionsHash: [...positionsHash],
          rebateTotal: new BN(0),
          timestamp: new BN(timestamp),
        })
        .accountsPartial({
          submitter: this.opts.operator.publicKey,
          config: this.pda.config,
          state: this.pda.state,
          idleVault: this.pda.idle,
          bondVault: this.pda.bond,
          authority: this.pda.authority,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([signature])
        .rpc(),
    );
    if (!result.ok) throw new Error(`NAV report rejected: ${result.error}`);
    await this.refresh();
    this.history.push({ t: this.now(), price: this.sharePrice() });
    if (this.history.length > 2_000) this.history.shift();
  }

  async settleEpoch(booking: EpochBooking): Promise<void> {
    const epoch = this.cache.epoch;
    const result = await this.send(null, "epoch", () =>
      this.program.methods
        .settleEpoch()
        .accountsPartial({
          payer: this.opts.operator.publicKey,
          config: this.pda.config,
          state: this.pda.state,
          idleVault: this.pda.idle,
          epochRecord: this.pda.epochRecord(epoch),
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
    );
    if (!result.ok) throw new Error(result.error);
    this.bookings.push({ t: this.now(), epoch, ...booking });
    if (this.bookings.length > 200) this.bookings.shift();
    await this.refresh();
    this.event("epoch", `Epoch ${epoch} settled on-chain`);
  }

  /** Permissionless breakers: open a recall after NAV silence, slash after a missed deadline. */
  async tick(): Promise<void> {
    const s = await this.recent();
    const now = await this.chainTime();
    if (s.drawnPrincipal > 0 && !s.recall && now * 1000 - s.navAt > this.params.navSilenceMs) {
      await this.send("NAV silence recall", "recall", () =>
        this.program.methods.checkNavSilence().accountsPartial({ config: this.pda.config, state: this.pda.state }).rpc(),
      );
    }
    if (s.recall && s.drawnPrincipal > 0 && now * 1000 > s.recall.deadline && s.bond > 0) {
      await this.send("Bond slash after missed recall", "slash", () =>
        this.program.methods
          .slashBond()
          .accountsPartial({
            config: this.pda.config,
            state: this.pda.state,
            idleVault: this.pda.idle,
            bondVault: this.pda.bond,
            authority: this.pda.authority,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      );
    }
  }

  // --- sentinel ---

  async pause(): Promise<void> {
    const result = await this.sentinel("pause");
    if (!result.ok) throw new Error(result.error);
  }

  async resume(): Promise<void> {
    const result = await this.sentinel("unpause");
    if (!result.ok) throw new Error(result.error);
  }

  async forceRecall(): Promise<Result> {
    return this.sentinel("forceRecall");
  }

  // --- internals ---

  private async sentinel(action: "pause" | "unpause" | "forceRecall"): Promise<TxResult> {
    const sentinel = this.opts.sentinel;
    if (!sentinel) return { ok: false, error: "No sentinel key loaded." };
    const label = { pause: "Sentinel paused draws", unpause: "Sentinel resumed draws", forceRecall: "Sentinel forced a recall" }[action];
    return this.send(label, "sentinel", () =>
      this.program.methods[action]()
        .accountsPartial({ sentinel: sentinel.publicKey, config: this.pda.config, state: this.pda.state })
        .signers([sentinel])
        .rpc(),
    );
  }

  private async returnFunds(kind: "repay" | "sweep", amount: Micros): Promise<TxResult> {
    if (!(amount > 0)) return { ok: false, error: "Amount must be positive." };
    const value = Math.floor(amount);
    const { gemini, mintAuthority, connection } = this.opts;
    const from = this.config.geminiDestination;
    const balance = Number((await getAccount(connection, from, "confirmed")).amount);
    if (balance < value) {
      if (!mintAuthority) return { ok: false, error: `Gemini account holds ${fmtUsd(balance)}, short of ${fmtUsd(value)}.` };
      await mintTo(connection, this.opts.operator, this.config.usdcMint, from, mintAuthority, value - balance);
    }
    const method = kind === "repay" ? this.program.methods.repay(new BN(value)) : this.program.methods.sweepProfit(new BN(value));
    const label = kind === "repay" ? `Repayment of ${fmtUsd(value)}` : `Profit sweep of ${fmtUsd(value)}`;
    return this.send(label, kind, () =>
      method
        .accountsPartial({
          payer: gemini.publicKey,
          config: this.pda.config,
          state: this.pda.state,
          idleVault: this.pda.idle,
          payerUsdc: from,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([gemini])
        .rpc(),
    );
  }

  private async send(label: string | null, kind: string, tx: () => Promise<string>): Promise<TxResult> {
    try {
      const signature = await tx();
      if (label) this.event(kind, `${label} (${signature.slice(0, 8)}…)`);
      return { ok: true };
    } catch (err) {
      const error = txError(err);
      if (label) this.event(kind, `${label} failed: ${error}`);
      return { ok: false, error };
    }
  }

  /** Vault state no older than `minRefreshMs`; concurrent callers share one read. */
  private recent(): Promise<VaultState> {
    if (this.now() - this.refreshedAt < this.minRefreshMs) return Promise.resolve(this.snapshot());
    return this.refresh();
  }

  private refresh(): Promise<VaultState> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<VaultState> {
    const { connection } = this.opts;
    const [state, idle, bond] = await Promise.all([
      this.program.account.vaultState.fetch(this.pda.state),
      getAccount(connection, this.pda.idle, "confirmed"),
      getAccount(connection, this.pda.bond, "confirmed"),
    ]);
    const n = (v: { toNumber(): number }) => v.toNumber();
    const idleBalance = Number(idle.amount);
    const pendingDeposits = n(state.pendingDeposits);
    const reserved = n(state.reservedWithdrawals);
    const totalShares = n(state.totalShares);
    const pendingWithdrawShares = n(state.pendingWithdrawShares);
    const free = Math.max(0, idleBalance - pendingDeposits - reserved);
    const equity = n(state.geminiEquity);
    const price = (free + equity + VIRTUAL_UNITS) / (totalShares + VIRTUAL_UNITS);
    const r = state.recall;
    this.raw = { totalShares, pendingDeposits, pendingWithdrawShares, reservedWithdrawals: reserved, idleBalance };
    this.cache = {
      idle: free,
      geminiEquity: equity,
      drawnPrincipal: n(state.drawnPrincipal),
      bond: Number(bond.amount),
      totalShares,
      paused: state.paused,
      recall: r.active
        ? {
            amount: n(r.amount),
            repaid: n(r.repaid),
            openedAt: n(r.openedAt) * 1000,
            deadline: n(r.deadline) * 1000,
            reason: REASONS[r.reason] ?? "breaker",
          }
        : null,
      queuedWithdrawals: Math.round(pendingWithdrawShares * price),
      navAt: n(state.navAt) * 1000,
      epoch: n(state.epoch),
      absoluteCap: this.config.absoluteCap,
    };
    this.refreshedAt = this.now();
    return this.snapshot();
  }

  private async balance(account: PublicKey): Promise<number> {
    try {
      return Number((await getAccount(this.opts.connection, account, "confirmed")).amount);
    } catch {
      return 0;
    }
  }

  /** Epoch records never change once written. */
  private async epochRecord(epoch: number): Promise<EpochPrice | null> {
    const hit = this.records.get(epoch);
    if (hit) return hit;
    const record = await this.program.account.epochRecord.fetchNullable(this.pda.epochRecord(epoch));
    if (!record) return null;
    const price = { assets: BigInt(record.assets.toString()), shares: BigInt(record.shares.toString()) };
    this.records.set(epoch, price);
    return price;
  }

  /** A wallet's vault deposits, withdrawal requests and claims, read incrementally from its transactions. */
  private async walletHistory(owner: PublicKey): Promise<WalletHistory> {
    const key = owner.toBase58();
    const known = this.histories.get(key) ?? { newest: undefined, deposits: [], requests: [], claims: [] };
    this.histories.set(key, known);
    const { connection } = this.opts;
    const sigs = await connection.getSignaturesForAddress(owner, { until: known.newest, limit: 1000 }, "confirmed");
    if (sigs.length === 0) return known;
    known.newest = sigs[0]!.signature;
    const live = sigs.filter((s) => s.err == null).map((s) => s.signature);
    const txs = live.length
      ? await connection.getTransactions(live, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      : [];
    txs.forEach((tx, i) => {
      if (!tx?.meta || tx.meta.err) return;
      const sig = live[i]!;
      const at = (tx.blockTime ?? Math.floor(this.now() / 1000)) * 1000;
      for (const event of this.parser.parseLogs(tx.meta.logMessages ?? [])) {
        const data = event.data as { owner: PublicKey; epoch: { toNumber(): number }; amount?: { toNumber(): number }; shares?: { toNumber(): number } };
        if (!data.owner?.equals?.(owner)) continue;
        if (event.name === "Deposited" && data.amount) {
          known.deposits.push({ epoch: data.epoch.toNumber(), amount: data.amount.toNumber(), at, sig });
        } else if (event.name === "WithdrawRequested" && data.shares) {
          known.requests.push({ epoch: data.epoch.toNumber(), shares: data.shares.toNumber(), at, sig });
        }
      }
      const message = tx.transaction.message;
      const keys = message.staticAccountKeys;
      const claimed = message.compiledInstructions.some(
        (ix) => keys[ix.programIdIndex]?.equals(PROGRAM_ID) && CLAIM_WITHDRAW.every((b, j) => ix.data[j] === b),
      );
      if (claimed) {
        const usdcOf = (rows: typeof tx.meta.postTokenBalances) =>
          Number(rows?.find((r) => r.owner === key && r.mint === this.config.usdcMint.toBase58())?.uiTokenAmount.amount ?? 0);
        known.claims.push({ usdc: usdcOf(tx.meta.postTokenBalances) - usdcOf(tx.meta.preTokenBalances), at, sig });
      }
    });
    return known;
  }

  /** Cluster time in seconds; NAV timestamps must not run ahead of it. */
  private async chainTime(): Promise<number> {
    const { connection } = this.opts;
    try {
      const time = await connection.getBlockTime(await connection.getSlot("confirmed"));
      if (time != null) return time;
    } catch {
      // Fall through to the wall clock.
    }
    return Math.floor(this.now() / 1000);
  }

  private event(kind: string, text: string): void {
    this.events.unshift({ at: this.now(), kind, text });
    if (this.events.length > 60) this.events.pop();
    this.log(text);
  }
}