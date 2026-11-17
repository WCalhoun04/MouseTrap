"use client";

import "./wallet-adapter.css";
import "./wallet-theme.css";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
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
    };

const IdentityContext = createContext<IdentityValue | null>(null);
const LedgerContext = createContext<LedgerValue>({ ready: false });

export function Providers({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("devnet"), []);
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
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

  const commit = useCallback((next: Ledger, session?: number) => {
    const prev = currentBook();
    replaceBook({
      ledger: next,
      now: Date.now(),
      session: session ?? prev.session,
    });
  }, []);

  const value = useMemo<LedgerValue>(() => {
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
  }, [book, bot, botSession, commit, refresh]);

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
