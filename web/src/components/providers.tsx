"use client";

import "./wallet-adapter.css";
import "./wallet-theme.css";
import { WalletAdapterNetwork, type WalletError } from "@solana/wallet-adapter-base";
import {
  ConnectionProvider,
  useWallet,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { asLedgerResult, botActions, fetchState, type BotState } from "@/lib/bot-api";
import { chainError, VaultChain, type Signer } from "@/lib/chain";
import {
  claim,
  deposit,
  loadSample,
  PREVIEW_WALLET_ID,
  readLedger,
  requestWithdraw,
  seedLedger,
  writeLedger,
  type Ledger,
  type LedgerResult,
} from "@/lib/ledger";

const PREVIEW_KEY = "mousetrap.preview-wallet";
const PREVIEW_EVENT = "mousetrap-preview";

function subscribePreview(listener: () => void) {
  window.addEventListener(PREVIEW_EVENT, listener);
  return () => window.removeEventListener(PREVIEW_EVENT, listener);
}

function previewSnapshot() {
  return window.localStorage.getItem(PREVIEW_KEY) === "1";
}

function writePreview(enabled: boolean) {
  if (enabled) window.localStorage.setItem(PREVIEW_KEY, "1");
  else window.localStorage.removeItem(PREVIEW_KEY);
  window.dispatchEvent(new Event(PREVIEW_EVENT));
}

type Book = { ledger: Ledger; now: number; session: number };

const SERVER_NOW = Date.UTC(2026, 10, 16, 22, 0, 0);
const SERVER_BOOK: Book = {
  ledger: seedLedger(SERVER_NOW),
  now: SERVER_NOW,
  session: 0,
};

let bookCache: Book | null = null;
const bookListeners = new Set<() => void>();

function subscribeBook(listener: () => void) {
  bookListeners.add(listener);
  return () => {
    bookListeners.delete(listener);
  };
}

function currentBook(): Book {
  if (!bookCache) {
    const now = Date.now();
    bookCache = { ledger: readLedger(now), now, session: 0 };
  }
  return bookCache;
}

function replaceBook(next: Book) {
  bookCache = next;
  writeLedger(next.ledger);
  bookListeners.forEach((listener) => listener());
}

type IdentityValue = {
  ready: boolean;
  preview: boolean;
  walletId: string | null;
  enablePreview: () => void;
  disablePreview: () => void;
};

type LedgerValue =
  | { ready: false }
  | {
      ready: true;
      ledger: Ledger;
      now: number;
      session: number;
      /** "bot" when the market maker bot's test mode is running, else the browser ledger. */
      source: "bot" | "local";
      bot: BotState | null;
      deposit: (walletId: string, amount: number, acceptRisk: boolean) => Promise<LedgerResult>;
      requestWithdraw: (walletId: string, amount: number) => Promise<LedgerResult>;
      claim: (walletId: string, withdrawalId: string) => Promise<LedgerResult>;
      loadSample: (walletId: string) => LedgerResult;
      reset: () => Promise<void>;
      /** True when the bot runs on the escrow program and the wallet signs every action. */
      onChain: boolean;
      /** Test SOL and USDC for the connected wallet; only on a local validator. */
      faucet: ((walletId: string) => Promise<LedgerResult>) | null;
    };

const IdentityContext = createContext<IdentityValue | null>(null);
const LedgerContext = createContext<LedgerValue>({ ready: false });

export function Providers({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("devnet"), []);
  // Phantom, MetaMask and other Wallet Standard wallets register themselves.
  const wallets = useMemo(() => [new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet })], []);
  // A closed or declined wallet popup is not an error; forms show their own message.
  const onError = useCallback((error: WalletError) => {
    if (/rejected/i.test(error.message)) return;
    console.error(error);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>
          <IdentityProvider>
            <LedgerProvider>{children}</LedgerProvider>
          </IdentityProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function IdentityProvider({ children }: { children: ReactNode }) {
  const { connected, publicKey } = useWallet();
  const preview = useSyncExternalStore(subscribePreview, previewSnapshot, () => false);

  const enablePreview = useCallback(() => writePreview(true), []);
  const disablePreview = useCallback(() => writePreview(false), []);

  const walletId =
    connected && publicKey
      ? publicKey.toBase58()
      : preview
        ? PREVIEW_WALLET_ID
        : null;

  const value = useMemo<IdentityValue>(
    () => ({ ready: true, preview, walletId, enablePreview, disablePreview }),
    [disablePreview, enablePreview, preview, walletId],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

const BOT_POLL_MS = 1_000;

/** Poll the bot's test-mode API. Null while it is not running. */
function useBotState(walletId: string | null): { bot: BotState | null; refresh: () => Promise<void> } {
  const [bot, setBot] = useState<BotState | null>(null);

  const refresh = useCallback(async () => {
    setBot(await fetchState(walletId));
  }, [walletId]);

  useEffect(() => {
    let cancelled = false;
    let misses = 0;
    const poll = async () => {
      const next = await fetchState(walletId);
      if (cancelled) return;
      // One dropped poll should not flip the whole app back to the local ledger.
      if (next) {
        misses = 0;
        setBot(next);
      } else if ((misses += 1) >= 3) {
        setBot(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), BOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [walletId]);

  return { bot, refresh };
}

function LedgerProvider({ children }: { children: ReactNode }) {
  const book = useSyncExternalStore(subscribeBook, currentBook, () => SERVER_BOOK);
  const identity = useContext(IdentityContext);
  const { bot, refresh } = useBotState(identity?.walletId ?? null);
  const [botSession, setBotSession] = useState(0);
  const { publicKey, signTransaction } = useWallet();
  const rpcUrl = bot?.chain?.rpcUrl;
  const programId = bot?.chain?.programId;
  const usdcMint = bot?.chain?.usdcMint;
  const faucetOn = bot?.chain?.faucet ?? false;
  const chain = useMemo(
    () => (rpcUrl && programId && usdcMint ? new VaultChain({ rpcUrl, programId, usdcMint, faucet: faucetOn }) : null),
    [rpcUrl, programId, usdcMint, faucetOn],
  );

  const commit = useCallback((next: Ledger, session?: number) => {
    const prev = currentBook();
    replaceBook({
      ledger: next,
      now: Date.now(),
      session: session ?? prev.session,
    });
  }, []);

  const value = useMemo<LedgerValue>(() => {
    if (bot && chain) {
      // The escrow program holds the funds: the wallet signs, the bot only reports state.
      const signer: Signer | null =
        publicKey && signTransaction ? { publicKey, signTransaction } : null;
      const run = async (walletId: string, action: (wallet: Signer) => Promise<unknown>) => {
        if (!signer || signer.publicKey.toBase58() !== walletId) {
          return { ok: false as const, error: "Connect a Solana wallet: this vault is on-chain." };
        }
        try {
          await action(signer);
        } catch (err) {
          return { ok: false as const, error: chainError(err) };
        }
        await refresh();
        return { ok: true as const, ledger: bot.ledger };
      };
      const user = (walletId: string) => bot.ledger.users[walletId];
      return {
        ready: true,
        ledger: bot.ledger,
        now: bot.now,
        session: botSession,
        source: "bot",
        bot,
        onChain: true,
        deposit: (walletId, amount) =>
          run(walletId, (wallet) => chain.deposit(wallet, Math.round(amount * 1e6))),
        requestWithdraw: (walletId, amount) =>
          run(walletId, (wallet) => {
            const held = Math.floor((user(walletId)?.shares ?? 0) * 1e6);
            const value = (held / 1e6) * bot.sharePrice;
            // Withdrawing (almost) everything burns every share, so no dust is left behind.
            const shares = amount >= value - 0.01 ? held : Math.min(held, Math.round((amount / bot.sharePrice) * 1e6));
            if (shares <= 0) throw new Error("You have no shares to withdraw.");
            return chain.requestWithdraw(wallet, shares);
          }),
        claim: (walletId, id) =>
          run(walletId, (wallet) => {
            const [kind, epoch] = id.split(":");
            if (kind === "deposit") return chain.claimDeposit(wallet, Number(epoch));
            return chain.claimWithdraw(wallet, Number(epoch));
          }),
        loadSample: () => ({ ok: false, error: "Samples only load in the browser preview." }),
        reset: async () => {},
        faucet: chain.info.faucet
          ? async (walletId) => {
              const result = await botActions.faucet(walletId);
              await refresh();
              return asLedgerResult(result, bot.ledger);
            }
          : null,
      };
    }

    if (bot) {
      // The bot's simulated escrow is the source of truth; the browser only displays it.
      const run = async (action: ReturnType<typeof botActions.deposit>) => {
        const result = await action;
        await refresh();
        return asLedgerResult(result, bot.ledger);
      };
      return {
        ready: true,
        ledger: bot.ledger,
        now: bot.now,
        session: botSession,
        source: "bot",
        bot,
        onChain: false,
        faucet: null,
        deposit: (walletId, amount, acceptRisk) =>
          run(botActions.deposit(walletId, amount, acceptRisk)),
        requestWithdraw: (walletId, amount) => run(botActions.requestWithdraw(walletId, amount)),
        claim: (walletId, withdrawalId) => run(botActions.claim(walletId, withdrawalId)),
        loadSample: () => ({ ok: false, error: "Samples only load in the browser preview." }),
        reset: async () => {
          await botActions.reset();
          await refresh();
          setBotSession((n) => n + 1);
        },
      };
    }

    const { ledger, now, session } = book;
    return {
      ready: true,
      ledger,
      now,
      session,
      source: "local",
      bot: null,
      onChain: false,
      faucet: null,
      deposit: async (walletId, amount, acceptRisk) => {
        const result = deposit(ledger, walletId, amount, Date.now(), acceptRisk);
        if (result.ok) commit(result.ledger);
        return result;
      },
      requestWithdraw: async (walletId, amount) => {
        const result = requestWithdraw(ledger, walletId, amount, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      claim: async (walletId, withdrawalId) => {
        const result = claim(ledger, walletId, withdrawalId, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      loadSample: (walletId) => {
        const result = loadSample(ledger, walletId, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      reset: async () => commit(seedLedger(Date.now()), book.session + 1),
    };
  }, [book, bot, botSession, chain, commit, publicKey, refresh, signTransaction]);

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useIdentity(): IdentityValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentity must be used within Providers");
  return value;
}

export function useLedger(): LedgerValue {
  return useContext(LedgerContext);
}
