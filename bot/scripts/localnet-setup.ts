/**
 * Initialises the escrow program on a local validator for `npm run test-mode -- --chain`:
 * a test USDC mint, a single attestor, the operator's bond and a seed deposit, with
 * limits taken from the bot's test-mode config so the bot and the program agree.
 *
 *   npm run localnet          # terminal 1: validator with the program preloaded
 *   npm run localnet:setup    # terminal 2: this script
 */
import "dotenv/config";
import anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, type Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { loadOrCreateKey, writeInfo } from "../src/chain/localnet.ts";
import { fmtUsd } from "../src/money.ts";
import { PROGRAM_ID, vaultPdas } from "../src/vault/chain.ts";
import type { MousetrapVault } from "../src/vault/idl/mousetrap_vault.ts";

const { AnchorProvider, BN, Program, Wallet } = anchor;
const OPERATOR_USDC = 50_000_000_000;

async function main() {
  const cfg = loadConfig("test", { chain: true });
  const connection = new Connection(cfg.rpcUrl, "confirmed");

  const program = await connection.getAccountInfo(PROGRAM_ID).catch(() => null);
  if (!program?.executable) {
    throw new Error(
      `Program ${PROGRAM_ID.toBase58()} is not on ${cfg.rpcUrl}. Build it (cd escrow && anchor build --arch v0), then start \`npm run localnet\`.`,
    );
  }

  const keys = {
    owner: loadOrCreateKey("owner"),
    operator: loadOrCreateKey("operator"),
    sentinel: loadOrCreateKey("sentinel"),
    attestor: loadOrCreateKey("attestor"),
    gemini: loadOrCreateKey("gemini"),
    feeRecipient: loadOrCreateKey("feeRecipient"),
    seedStaker: loadOrCreateKey("seedStaker"),
    usdcMint: loadOrCreateKey("usdcMint"),
  };
  const pda = vaultPdas();
  if (await connection.getAccountInfo(pda.config)) {
    console.log("The vault is already initialised on this validator. Restart `npm run localnet` (it resets) to start over.");
    return;
  }

  for (const key of [keys.owner, keys.operator, keys.sentinel, keys.gemini, keys.seedStaker]) {
    const sig = await connection.requestAirdrop(key.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const mint = await createMint(connection, keys.owner, keys.owner.publicKey, null, 6, keys.usdcMint);
  const ata = async (owner: Keypair) =>
    (await getOrCreateAssociatedTokenAccount(connection, keys.owner, mint, owner.publicKey)).address;
  const geminiUsdc = await ata(keys.gemini);
  const operatorUsdc = await ata(keys.operator);
  const seedUsdc = await ata(keys.seedStaker);
  await mintTo(connection, keys.owner, mint, operatorUsdc, keys.owner, OPERATOR_USDC);
  await mintTo(connection, keys.owner, mint, seedUsdc, keys.owner, cfg.seedDeposits);

  const idl = JSON.parse(readFileSync(new URL("../src/vault/idl/mousetrap_vault.json", import.meta.url), "utf8")) as MousetrapVault;
  const as = (signer: Keypair) =>
    new Program<MousetrapVault>(idl, new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" }));

  const v = cfg.vault;
  const bps = (share: number) => Math.round(share * 10_000);
  const secs = (ms: number) => new BN(Math.max(1, Math.ceil(ms / 1000)));
  const attestors = [keys.attestor.publicKey, ...Array<PublicKey>(4).fill(PublicKey.default)];
  const settings = {
    params: {
      bondMinBps: bps(v.bondMin),
      absoluteCap: new BN(v.absoluteCap),
      drawnNavMaxBps: bps(v.drawnNavMax),
      bufferBps: bps(v.bufferRatio),
      healthMinBps: bps(v.healthMin),
      recallHealthBps: bps(v.recallHealth),
      perDrawBps: bps(v.perDrawShare),
      navMaxAgeSecs: secs(v.navMaxAgeMs),
      navSilenceSecs: secs(Math.max(v.navSilenceMs, v.navMaxAgeMs)),
      recallDeadlineSecs: secs(v.recallDeadlineMs),
      // Half an epoch, so timer jitter never makes a settlement land too early.
      epochMinSecs: new BN(Math.floor(cfg.epochMs / 2000)),
      performanceFeeBps: 2_000,
      depositCap: new BN(0),
    },
    sentinel: keys.sentinel.publicKey,
    operator: keys.operator.publicKey,
    feeRecipient: keys.feeRecipient.publicKey,
    geminiDestination: geminiUsdc,
    attestors,
    attestorCount: 1,
    quorum: 1,
  };

  await as(keys.owner)
    .methods.initialize(settings)
    .accountsPartial({
      owner: keys.owner.publicKey,
      config: pda.config,
      state: pda.state,
      authority: pda.authority,
      usdcMint: mint,
      shareMint: pda.shareMint,
      idleVault: pda.idle,
      bondVault: pda.bond,
      geminiDestination: geminiUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await as(keys.operator)
    .methods.postBond(new BN(cfg.seedBond))
    .accountsPartial({
      payer: keys.operator.publicKey,
      config: pda.config,
      bondVault: pda.bond,
      payerUsdc: operatorUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  await as(keys.seedStaker)
    .methods.deposit(new BN(cfg.seedDeposits))
    .accountsPartial({
      owner: keys.seedStaker.publicKey,
      config: pda.config,
      state: pda.state,
      idleVault: pda.idle,
      ownerUsdc: seedUsdc,
      ticket: pda.depositTicket(keys.seedStaker.publicKey, 1),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  writeInfo({
    rpcUrl: cfg.rpcUrl,
    programId: PROGRAM_ID.toBase58(),
    usdcMint: mint.toBase58(),
    geminiUsdc: geminiUsdc.toBase58(),
  });

  console.log(`Vault initialised on ${cfg.rpcUrl}`);
  console.log(`  program        ${PROGRAM_ID.toBase58()}`);
  console.log(`  test USDC mint ${mint.toBase58()}`);
  console.log(`  Gemini account ${geminiUsdc.toBase58()} (draw destination)`);
  console.log(`  bond ${fmtUsd(cfg.seedBond)}, seed deposit ${fmtUsd(cfg.seedDeposits)} (shares mint at the first settlement)`);
  console.log(`  operator USDC  ${getAssociatedTokenAddressSync(mint, keys.operator.publicKey).toBase58()}`);
  console.log("Now run: npm run test-mode -- --chain");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
