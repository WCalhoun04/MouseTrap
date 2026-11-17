import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

/** True for a validator on this machine; anything else (devnet) gets its own keys. */
export function isLocalCluster(rpcUrl: string = clusterUrl()): boolean {
  return /localhost|127\.0\.0\.1/.test(rpcUrl);
}

export function clusterUrl(): string {
  return process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
}

/**
 * Keys and addresses written by `npm run localnet:setup`: `.localnet/` for a local
 * validator, `.devnet/` otherwise. Gitignored; back up `.devnet/`, it holds the
 * operator, attestor and sentinel keys of the shared devnet vault.
 */
export function clusterDir(): URL {
  return new URL(isLocalCluster() ? "../../.localnet/" : "../../.devnet/", import.meta.url);
}
const keysDir = () => new URL("keys/", clusterDir());
const infoFile = () => new URL("vault.json", clusterDir());

export const KEY_NAMES = ["owner", "operator", "sentinel", "attestor", "gemini", "feeRecipient", "seedStaker", "usdcMint"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export type LocalnetInfo = {
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  /** USDC token account standing in for the operator's Gemini deposit address. */
  geminiUsdc: string;
};

export function keyFile(name: KeyName): URL {
  return new URL(`${name}.json`, keysDir());
}

export function loadOrCreateKey(name: KeyName): Keypair {
  const file = keyFile(name);
  if (existsSync(file)) return loadKey(name);
  mkdirSync(keysDir(), { recursive: true });
  const key = Keypair.generate();
  writeFileSync(file, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  return key;
}

export function loadKey(name: KeyName): Keypair {
  const file = keyFile(name);
  if (!existsSync(file)) throw new Error(`Missing ${file.pathname}. Run \`npm run localnet:setup\` first.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

export function writeInfo(info: LocalnetInfo): void {
  mkdirSync(clusterDir(), { recursive: true });
  writeFileSync(infoFile(), `${JSON.stringify(info, null, 2)}\n`);
}

export function readInfo(): LocalnetInfo {
  if (!existsSync(infoFile())) {
    throw new Error(`No vault set up for ${clusterUrl()}. Run \`npm run localnet:setup\` with the same SOLANA_RPC_URL.`);
  }
  return JSON.parse(readFileSync(infoFile(), "utf8")) as LocalnetInfo;
}

export function pubkey(text: string): PublicKey {
  return new PublicKey(text);
}
