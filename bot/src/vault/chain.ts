import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import type { Program as ProgramT } from "@coral-xyz/anchor";
import { getAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import type { VaultParams } from "../config.ts";
import { fmtUsd, type Micros } from "../money.ts";
import { checkDraw } from "./gate.ts";
import type { Account, Booking, Result, VaultEvent } from "./sim.ts";
import type { EpochBooking, GateResult, Recall, TxResult, VaultClient, VaultCrank, VaultState } from "./types.ts";
import type { MousetrapVault } from "./idl/mousetrap_vault.ts";

const { AnchorProvider, BN, Program, Wallet } = anchor;

const IDL = JSON.parse(readFileSync(new URL("./idl/mousetrap_vault.json", import.meta.url), "utf8")) as MousetrapVault;
export const PROGRAM_ID = new PublicKey(IDL.address);

const VIRTUAL_UNITS = 1_000_000;
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
  now?: () => number;
  log?: (text: string) => void;
};

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
    return this.refresh();
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

  /** Stakers sign their own deposits and withdrawals; the bot holds no staker funds. */
  account(_wallet: string): Account {
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
    await this.refresh();
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
    const s = await this.refresh();
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

  private async refresh(): Promise<VaultState> {
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
    return this.snapshot();
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