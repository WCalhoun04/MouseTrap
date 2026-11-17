import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

/** Keys and addresses for a local validator, written by `npm run localnet:setup`. Gitignored. */
export const LOCALNET_DIR = new URL("../../.localnet/", import.meta.url);
const KEYS_DIR = new URL("keys/", LOCALNET_DIR);
const INFO_FILE = new URL("vault.json", LOCALNET_DIR);

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
  return new URL(`${name}.json`, KEYS_DIR);
}

export function loadOrCreateKey(name: KeyName): Keypair {
  const file = keyFile(name);
  if (existsSync(file)) return loadKey(name);
  mkdirSync(KEYS_DIR, { recursive: true });
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
  mkdirSync(LOCALNET_DIR, { recursive: true });
  writeFileSync(INFO_FILE, `${JSON.stringify(info, null, 2)}\n`);
}

export function readInfo(): LocalnetInfo {
  if (!existsSync(INFO_FILE)) {
    throw new Error("No local vault found. Start `npm run localnet`, then run `npm run localnet:setup`.");
  }
  return JSON.parse(readFileSync(INFO_FILE, "utf8")) as LocalnetInfo;
}

export function pubkey(text: string): PublicKey {
  return new PublicKey(text);
}
