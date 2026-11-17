"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useIdentity, useLedger } from "@/components/providers";
import { sourceLabel } from "@/lib/bot-api";
import { formatWallet } from "@/lib/format";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="h-1 bg-brass" />
      <Header />
      <PreviewBanner />
      <main className="flex-1">{children}</main>
      <footer className="mx-auto w-full max-w-6xl px-4 py-10 text-sm leading-6 text-faint sm:px-6">
        <p>
          MouseTrap is a maker-rebate vault. Stakers hold mvUSDC. The share price is
          attested net asset value divided by shares. Yield here is that price change,
          booked as maker rebates, liquidity rewards, and spread.
        </p>
        <p className="mt-2">
          In the design, the operator earns a performance fee only above a hurdle. This
          preview shows the full share-price change.
        </p>
      </footer>
    </div>
  );
}

function Header() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ink/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-paper">
          <Mark className="h-7 w-7 text-brass" />
          <span className="font-serif text-xl tracking-tight">MouseTrap</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink href="/" active={pathname === "/"}>
            Vault
          </NavLink>
          <NavLink href="/health" active={pathname === "/health"}>
            Health
          </NavLink>
          <NavLink href="/operator" active={pathname === "/operator"}>
            Operator
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="hidden font-mono text-[11px] tracking-[0.16em] text-faint uppercase sm:inline">
            Devnet preview
          </span>
          <WalletControl />
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 ${active ? "bg-sheet text-paper" : "text-muted hover:text-paper"}`}
    >
      {children}
    </Link>
  );
}

function WalletControl() {
  const { connected, connecting, disconnect, publicKey } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const { ready, preview, walletId, enablePreview, disablePreview } = useIdentity();
  const [balance, setBalance] = useState<{ id: string; sol: number } | null>(null);

  useEffect(() => {
    if (!publicKey) return;
    const id = publicKey.toBase58();
    let cancel = false;
    connection.getBalance(publicKey).then(
      (lamports) => {
        if (!cancel) setBalance({ id, sol: lamports / 1_000_000_000 });
      },
      () => {
        if (!cancel) setBalance(null);
      },
    );
    return () => {
      cancel = true;
    };
  }, [connection, publicKey]);

  const sol = publicKey && balance?.id === publicKey.toBase58() ? balance.sol : null;

  if (!ready) return <div className="h-10 w-36" />;

  if (connected && publicKey && walletId) {
    return (
      <div className="flex items-center gap-2">
        <div className="text-right">
          <p className="font-mono text-sm text-paper">{formatWallet(walletId)}</p>
          {sol !== null && (
            <p className="font-mono text-[11px] text-faint">{sol.toFixed(3)} SOL devnet</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => disconnect()}
          className="rounded-full border border-line px-3 py-2 text-sm text-paper hover:bg-sheet"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {preview ? (
        <button
          type="button"
          onClick={disablePreview}
          className="rounded-full border border-line px-3 py-2 text-sm text-paper hover:bg-sheet"
        >
          Exit preview
        </button>
      ) : (
        <button
          type="button"
          onClick={enablePreview}
          className="px-1 text-sm text-muted underline-offset-4 hover:text-paper hover:underline"
        >
          Preview wallet
        </button>
      )}
      <button
        type="button"
        onClick={() => setVisible(true)}
        disabled={connecting}
        className="rounded-full bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-white disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    </div>
  );
}

function PreviewBanner() {
  const ledger = useLedger();
  const [armed, setArmed] = useState(false);

  return (
    <div className="border-b border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {ledger.ready && ledger.bot ? (
          <p className="max-w-3xl text-sm leading-6 text-muted">
            <span className="text-brass">{sourceLabel(ledger.bot)}.</span> The market maker bot
            is running against a simulated escrow. Deposits fund its draws with test USDC. No
            real orders or tokens move.
          </p>
        ) : (
          <p className="max-w-3xl text-sm leading-6 text-muted">
            Preview ledger. A wallet names your position. Deposits and withdrawals move
            preview USDC stored in this browser. Wallet tokens stay put until the escrow
            program is deployed.
          </p>
        )}
        {ledger.ready &&
          (armed ? (
            <button
              type="button"
              onClick={() => {
                void ledger.reset();
                setArmed(false);
              }}
              className="rounded-full border border-danger/40 px-3 py-1.5 text-sm text-danger"
            >
              Confirm reset
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              className="rounded-full border border-line px-3 py-1.5 text-sm text-muted hover:text-paper"
            >
              {ledger.bot ? "Reset test data" : "Reset preview data"}
            </button>
          ))}
      </div>
    </div>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="25"
        height="25"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 20V8.5h2.6l3.4 6.4 3.4-6.4H20V20h-2.2v-6.6L14.6 19h-1.2l-3.2-5.6V20H8z"
        fill="currentColor"
      />
    </svg>
  );
}
