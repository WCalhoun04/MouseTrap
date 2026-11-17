import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import idl from "@/lib/idl/mousetrap_vault.json";

// Staker transactions for the escrow program, signed by the connected wallet.
// Instructions are built straight from the IDL so the browser needs no Anchor client.

export type ChainInfo = { rpcUrl: string; programId: string; usdcMint: string; faucet: boolean };

export type Signer = {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
/** `VaultState.epoch`: discriminator, four u64 fields, a 32-byte hash, then one more u64. */
const STATE_EPOCH_OFFSET = 80;

type IdlInstruction = {
  name: string;
  discriminator: number[];
  accounts: { name: string; writable?: boolean; signer?: boolean }[];
};

const seed = (text: string) => Buffer.from(text);

function u64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

function pdas(programId: PublicKey) {
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: pda(seed("config")),
    state: pda(seed("state")),
    authority: pda(seed("authority")),
    idle: pda(seed("idle")),
    shareMint: pda(seed("shares")),
    epochRecord: (epoch: number) => pda(seed("epoch"), u64(epoch)),
    deposit: (owner: PublicKey, epoch: number) => pda(seed("deposit"), owner.toBuffer(), u64(epoch)),
    withdraw: (owner: PublicKey, epoch: number) => pda(seed("withdraw"), owner.toBuffer(), u64(epoch)),
  };
}

function instruction(
  programId: PublicKey,
  name: string,
  accounts: Record<string, PublicKey>,
  args: Buffer[] = [],
): TransactionInstruction {
  const def = (idl.instructions as IdlInstruction[]).find((ix) => ix.name === name);
  if (!def) throw new Error(`The IDL has no ${name} instruction.`);
  const keys: AccountMeta[] = def.accounts.map((account) => {
    const pubkey = accounts[account.name];
    if (!pubkey) throw new Error(`${name}: missing account ${account.name}.`);
    return { pubkey, isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
  });
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.concat([Buffer.from(def.discriminator), ...args]),
  });
}

/** The program's error message from a failed transaction, or the wallet's. */
export function chainError(err: unknown): string {
  const e = err as { logs?: string[]; message?: string };
  const logs = e.logs ?? [];
  const anchorLine = logs.find((line) => line.includes("Error Message:"));
  if (anchorLine) return anchorLine.split("Error Message:")[1].trim();
  const message = e.message ?? String(err);
  const fromMessage = message.match(/Error Message: ([^.]+\.)/);
  if (fromMessage) return fromMessage[1];
  if (/insufficient (funds|lamports)/i.test(message)) return "Not enough SOL or USDC in this wallet. Use the faucet.";
  if (/User rejected/i.test(message)) return "You rejected the transaction in your wallet.";
  return message;
}

export class VaultChain {
  readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly usdcMint: PublicKey;
  private readonly pda: ReturnType<typeof pdas>;

  constructor(readonly info: ChainInfo) {
    this.connection = new Connection(info.rpcUrl, "confirmed");
    this.programId = new PublicKey(info.programId);
    this.usdcMint = new PublicKey(info.usdcMint);
    this.pda = pdas(this.programId);
  }

  /** Read fresh: tickets are keyed by the epoch at the moment the transaction lands. */
  async epoch(): Promise<number> {
    const account = await this.connection.getAccountInfo(this.pda.state, "confirmed");
    if (!account) throw new Error("The vault is not initialised on this cluster.");
    return Number(Buffer.from(account.data).readBigUInt64LE(STATE_EPOCH_OFFSET));
  }

  async deposit(wallet: Signer, amount: number): Promise<string> {
    const owner = wallet.publicKey;
    const epoch = await this.epoch();
    const ix = instruction(
      this.programId,
      "deposit",
      {
        owner,
        config: this.pda.config,
        state: this.pda.state,
        idle_vault: this.pda.idle,
        owner_usdc: ata(this.usdcMint, owner),
        ticket: this.pda.deposit(owner, epoch),
        token_program: TOKEN_PROGRAM,
        system_program: SYSTEM_PROGRAM,
      },
      [u64(amount)],
    );
    return this.send(wallet, ix);
  }

  async claimDeposit(wallet: Signer, epoch: number): Promise<string> {
    const owner = wallet.publicKey;
    const ix = instruction(this.programId, "claim_deposit", {
      owner,
      config: this.pda.config,
      state: this.pda.state,
      ticket: this.pda.deposit(owner, epoch),
      epoch_record: this.pda.epochRecord(epoch),
      share_mint: this.pda.shareMint,
      owner_shares: ata(this.pda.shareMint, owner),
      authority: this.pda.authority,
      token_program: TOKEN_PROGRAM,
      associated_token_program: ATA_PROGRAM,
      system_program: SYSTEM_PROGRAM,
    });
    return this.send(wallet, ix);
  }

  async requestWithdraw(wallet: Signer, shares: number): Promise<string> {
    const owner = wallet.publicKey;
    const epoch = await this.epoch();
    const ix = instruction(
      this.programId,
      "request_withdraw",
      {
        owner,
        config: this.pda.config,
        state: this.pda.state,
        share_mint: this.pda.shareMint,
        owner_shares: ata(this.pda.shareMint, owner),
        ticket: this.pda.withdraw(owner, epoch),
        token_program: TOKEN_PROGRAM,
        system_program: SYSTEM_PROGRAM,
      },
      [u64(shares)],
    );
    return this.send(wallet, ix);
  }

  async claimWithdraw(wallet: Signer, epoch: number): Promise<string> {
    const owner = wallet.publicKey;
    const ix = instruction(this.programId, "claim_withdraw", {
      owner,
      config: this.pda.config,
      state: this.pda.state,
      ticket: this.pda.withdraw(owner, epoch),
      epoch_record: this.pda.epochRecord(epoch),
      idle_vault: this.pda.idle,
      owner_usdc: ata(this.usdcMint, owner),
      authority: this.pda.authority,
      token_program: TOKEN_PROGRAM,
    });
    return this.send(wallet, ix);
  }

  private async send(wallet: Signer, ix: TransactionInstruction): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
    const signed = await wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signed.serialize());
    const result = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
    return signature;
  }
}
