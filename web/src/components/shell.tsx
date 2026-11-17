"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useIdentity } from "@/components/providers";
import { formatWallet } from "@/lib/format";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="h-1 bg-brass" />
      <Header />
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
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-paper">
          <Image
            src="/logo-mark.png"
            alt=""
            width={512}
            height={512}
            priority
            className="h-10 w-10 object-contain"
          />
          <span className="font-serif text-xl tracking-tight">Mouse Trap</span>
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
            <p className="font-mono text-[11px] text-faint">{sol.toFixed(3)} SOL</p>
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
