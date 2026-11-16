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
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
      deposit: (walletId: string, amount: number, acceptRisk: boolean) => LedgerResult;
      requestWithdraw: (walletId: string, amount: number) => LedgerResult;
      claim: (walletId: string, withdrawalId: string) => LedgerResult;
      loadSample: (walletId: string) => LedgerResult;
      reset: () => void;
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

function LedgerProvider({ children }: { children: ReactNode }) {
  const book = useSyncExternalStore(subscribeBook, currentBook, () => SERVER_BOOK);

  const commit = useCallback((next: Ledger, session?: number) => {
    const prev = currentBook();
    replaceBook({
      ledger: next,
      now: Date.now(),
      session: session ?? prev.session,
    });
  }, []);

  const value = useMemo<LedgerValue>(() => {
    const { ledger, now, session } = book;
    return {
      ready: true,
      ledger,
      now,
      session,
      deposit: (walletId, amount, acceptRisk) => {
        const result = deposit(ledger, walletId, amount, Date.now(), acceptRisk);
        if (result.ok) commit(result.ledger);
        return result;
      },
      requestWithdraw: (walletId, amount) => {
        const result = requestWithdraw(ledger, walletId, amount, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      claim: (walletId, withdrawalId) => {
        const result = claim(ledger, walletId, withdrawalId, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      loadSample: (walletId) => {
        const result = loadSample(ledger, walletId, Date.now());
        if (result.ok) commit(result.ledger);
        return result;
      },
      reset: () => commit(seedLedger(Date.now()), book.session + 1),
    };
  }, [book, commit]);

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
