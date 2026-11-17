"use client";

import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PageLoader } from "@/components/page-loader";
import { ScrollBox, STICKY_HEAD } from "@/components/scroll-box";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useIdentity, useLedger } from "@/components/providers";
import { ShareChart } from "@/components/share-chart";
import { splitByBookings } from "@/lib/bot-api";
import {
  formatAge,
  formatPct,
  formatShares,
  formatUsd,
  formatWallet,
  formatWhen,
  parseUsdInput,
} from "@/lib/format";
import {
  accountYield,
  drawStatus,
  getUser,
  planWithdraw,
  priceSeries,
  readings,
  sharePrice,
  trailingReturn,
  type ActivityKind,
  type UserAccount,
} from "@/lib/ledger";

export function VaultScreen() {
  const identity = useIdentity();
  const ledgerApi = useLedger();

  if (!identity.ready || !ledgerApi.ready) {
    return <PageLoader />;
  }

  const { ledger, now, bot } = ledgerApi;
  const local = readings(ledger.vault, now);
  // With the bot running, epoch, NAV time and price history are the real ones.
  const view = bot ? { ...local, epoch: bot.epoch, navAt: bot.navAt } : local;
  const status = bot?.recall ? "recall" : bot && !bot.gate.ok ? "blocked" : drawStatus(ledger.vault);
  const series = bot && bot.history.length > 1 ? bot.history : priceSeries(now, 90);
  const change = bot
    ? view.price / (bot.history[0]?.price ?? view.price) - 1
    : trailingReturn(now, view.price, 30);
  const user = identity.walletId ? getUser(ledger, identity.walletId) : null;
  const baseYield = user ? accountYield(user, view.price) : null;
  const yieldView =
    bot && baseYield ? { ...baseYield, ...splitByBookings(baseYield.total, bot.bookings) } : baseYield;
  const yieldText = yieldCopy(identity.walletId, user, yieldView);
  const statusLabel =
    status === "open" ? "Draws open" : status === "blocked" ? "Draws blocked" : "Recall open";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
        <span>Epoch {view.epoch}</span>
        <span className="text-line">/</span>
        <span>Share price {formatUsd(view.price, 4)}</span>
        <span className="text-line">/</span>
        <span className={status === "open" ? "text-sage" : "text-danger"}>{statusLabel}</span>
        <span className="text-line">/</span>
        <span>NAV {formatAge(view.navAt, now)}</span>
        <Link href="/health" className="text-brass normal-case tracking-normal hover:underline">
          View health
        </Link>
      </p>

      <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
              Your yield
            </h1>
            <p
              className={`mt-2 font-serif text-5xl italic tabular-nums sm:text-6xl ${
                yieldView && yieldView.total > 0
                  ? "text-sage"
                  : yieldView && yieldView.total < 0
                    ? "text-danger"
                    : "text-paper"
              }`}
            >
              {yieldView ? formatUsd(yieldView.total) : "—"}
            </p>
            {yieldText && <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{yieldText}</p>}
          </div>
          {!bot && identity.walletId && user && user.lifetimeDeposited === 0 && (
            <button
              type="button"
              onClick={() => ledgerApi.loadSample(identity.walletId as string)}
              className="rounded-full border border-line px-4 py-2 text-sm text-paper hover:bg-sheet-2"
            >
              Load a 30-day sample
            </button>
          )}
        </div>
        {yieldView && (
          <ul className="mt-6 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Split label="Rebates" value={yieldView.rebates} />
            <Split label="Rewards" value={yieldView.rewards} />
            <Split label="Spread" value={yieldView.spread} />
          </ul>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="flex flex-col rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
                Share price
              </h2>
              <p className="mt-2 font-serif text-4xl tabular-nums">{formatUsd(view.price, 4)}</p>
            </div>
            <p className={`font-mono text-sm ${change >= 0 ? "text-sage" : "text-danger"}`}>
              {formatPct(change)} / {bot ? "this session" : "30 days"}
            </p>
          </div>
          <ShareChart
            points={series}
            livePrice={view.price}
            span={bot ? "this session" : "over 90 days"}
            clock={Boolean(bot)}
            className="flex-1"
          />
        </section>
        <TradePanel />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PositionCard />
        <ActivityCard />
      </div>
    </div>
  );
}

function Split({ label, value }: { label: string; value: number }) {
  return (
    <li>
      <p className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">{label}</p>
      <p className={`mt-1 font-mono text-lg tabular-nums ${value < 0 ? "text-danger" : "text-paper"}`}>
        {formatUsd(value)}
      </p>
    </li>
  );
}

function yieldCopy(
  walletId: string | null,
  user: UserAccount | null,
  yieldView: { total: number; pct: number } | null,
): string {
  if (!walletId) return "Connect a wallet to see the yield on your shares.";
  if (!user || user.lifetimeDeposited === 0 || !yieldView) return "";
  return `${formatPct(yieldView.pct)} on ${formatUsd(user.lifetimeDeposited)} deposited${
    user.depositedAt ? `, since ${formatWhen(user.depositedAt)} UTC` : ""
  }.`;
}

function TradePanel() {
  const identity = useIdentity();
  const ledgerApi = useLedger();
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");

  if (!identity.ready || !ledgerApi.ready) return null;
  if (!identity.walletId) {
    return (
      <section className="flex flex-col justify-between rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
        <div>
          <h2 className="font-serif text-2xl">Open a position</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Connect Phantom or Solflare, or use a guest wallet to try deposit,
            yield, and withdraw in this browser.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <HeaderConnect />
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
      <div className="grid grid-cols-2 rounded-full border border-line p-1 text-sm">
        <TabButton active={tab === "deposit"} onClick={() => setTab("deposit")}>
          Deposit
        </TabButton>
        <TabButton active={tab === "withdraw"} onClick={() => setTab("withdraw")}>
          Withdraw
        </TabButton>
      </div>
      {tab === "deposit" ? (
        <DepositForm key={`${identity.walletId}-${ledgerApi.session}`} />
      ) : (
        <WithdrawForm key={`${identity.walletId}-${ledgerApi.session}`} />
      )}
      <Tickets key={`tickets-${identity.walletId}-${ledgerApi.session}`} />
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-2 ${active ? "bg-paper text-ink" : "text-muted hover:text-paper"}`}
    >
      {children}
    </button>
  );
}

function HeaderConnect() {
  const { setVisible } = useWalletModal();
  const { enablePreview, preview } = useIdentity();
  return (
    <>
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="rounded-full bg-paper px-4 py-2 text-sm font-medium text-ink"
      >
        Connect wallet
      </button>
      {!preview && (
        <button
          type="button"
          onClick={enablePreview}
          className="rounded-full border border-line px-4 py-2 text-sm text-paper"
        >
          Guest wallet
        </button>
      )}
    </>
  );
}

function DepositForm() {
  const { walletId } = useIdentity();
  const ledgerApi = useLedger();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!ledgerApi.ready || !walletId) return null;
  const user = getUser(ledgerApi.ledger, walletId);
  const price = sharePrice(ledgerApi.ledger.vault);
  const parsed = parseUsdInput(amount);
  const shares = parsed ? parsed / price : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ledgerApi.ready || !walletId || !user) return;
    const usdc = parseUsdInput(amount);
    if (usdc === null) {
      setError("Enter a USDC amount.");
      setNotice(null);
      return;
    }
    const result = await ledgerApi.deposit(walletId, usdc, true);
    if (!result.ok) {
      setError(result.error);
      setNotice(null);
      return;
    }
    setError(null);
    setNotice(
      ledgerApi.onChain
        ? `Deposited ${formatUsd(usdc)}. Shares mint when this epoch settles; claim them below.`
        : `Deposited ${formatUsd(usdc)}.`,
    );
    setAmount("");
  }

  async function onFaucet() {
    if (!ledgerApi.ready || !walletId || !ledgerApi.faucet) return;
    setNotice("Requesting test SOL and USDC…");
    const result = await ledgerApi.faucet(walletId);
    setError(result.ok ? null : result.error);
    setNotice(result.ok ? "Test USDC is in your wallet." : null);
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4" noValidate>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="deposit-amount" className="text-sm text-muted">
          Amount
        </label>
        <button
          type="button"
          onClick={() => setAmount(user.cash.toFixed(2))}
          className="font-mono text-xs text-brass hover:underline"
        >
          {formatUsd(user.cash)} available
        </button>
      </div>
      <AmountField id="deposit-amount" value={amount} onChange={setAmount} />
      <p className="text-sm text-muted">
        {ledgerApi.onChain
          ? `Shares mint at this epoch's settlement price${shares ? `, about ${formatShares(shares)}` : ""} (now ${formatUsd(price, 4)}).`
          : shares
            ? `You receive ${formatShares(shares)} at ${formatUsd(price, 4)} per share.`
            : `Share price ${formatUsd(price, 4)}.`}
      </p>
      {ledgerApi.faucet && (
        <button type="button" onClick={onFaucet} className="self-start font-mono text-xs text-brass hover:underline">
          Get test SOL and USDC
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-sage">{notice}</p>}
      <button
        type="submit"
        className="rounded-full bg-brass px-4 py-3 text-sm font-medium text-brass-ink hover:bg-[#f0c56e]"
      >
        Deposit
      </button>
    </form>
  );
}

function WithdrawForm() {
  const { walletId } = useIdentity();
  const ledgerApi = useLedger();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!ledgerApi.ready || !walletId) return null;
  const user = getUser(ledgerApi.ledger, walletId);
  const price = sharePrice(ledgerApi.ledger.vault);
  const available = user.shares * price;
  const parsed = parseUsdInput(amount);
  const fromBot = ledgerApi.source === "bot";
  const planned = parsed === null ? null : planWithdraw(ledgerApi.ledger, walletId, parsed);
  // The bot's vault knows every wallet's pending claims, so its idle room is the one to trust.
  const room = ledgerApi.bot?.instantRoom;
  const quote =
    planned && planned.ok && room !== undefined
      ? {
          ...planned,
          instantRoom: room,
          settlement: planned.payout <= room ? ("instant" as const) : ("queued" as const),
        }
      : planned;
  const queued = user.withdrawals.some((item) => item.settlement === "queued");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ledgerApi.ready || !walletId) return;
    const usdc = parseUsdInput(amount);
    if (usdc === null) {
      setError("Enter a USDC amount.");
      setNotice(null);
      return;
    }
    const result = await ledgerApi.requestWithdraw(walletId, usdc);
    if (!result.ok) {
      setError(result.error);
      setNotice(null);
      return;
    }
    setError(null);
    setNotice(
      ledgerApi.onChain
        ? "Withdrawal requested. It is priced when this epoch settles; claim it below."
        : "Withdrawal requested. Claim it below.",
    );
    setAmount("");
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4" noValidate>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="withdraw-amount" className="text-sm text-muted">
          Amount
        </label>
        <button
          type="button"
          onClick={() => setAmount(Math.max(0, Math.floor(available * 100) / 100).toFixed(2))}
          className="font-mono text-xs text-brass hover:underline"
        >
          {formatUsd(available)} available
        </button>
      </div>
      <AmountField id="withdraw-amount" value={amount} onChange={setAmount} />
      {quote && quote.ok && (
        <p className="text-sm leading-6 text-muted">
          {ledgerApi.onChain
            ? `Burns about ${formatShares(quote.shares)} now. The USDC is priced at this epoch's settlement and paid from idle USDC; above the idle room of ${formatUsd(quote.instantRoom)} it waits for the operator to repay.`
            : quote.settlement === "instant"
            ? `${formatUsd(quote.payout)} can be claimed from the idle buffer.`
            : fromBot
              ? `${formatUsd(quote.payout)} is above the idle room of ${formatUsd(quote.instantRoom)}. It opens a recall, and you can claim once the bot has repaid it.`
              : `${formatUsd(quote.payout)} is above the idle room of ${formatUsd(quote.instantRoom)}. It is paid from a recall on the operator.`}
        </p>
      )}
      {quote && !quote.ok && <p className="text-sm text-danger">{quote.error}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-sage">{notice}</p>}
      <button
        type="submit"
        className="rounded-full border border-paper px-4 py-3 text-sm font-medium text-paper hover:bg-paper hover:text-ink"
      >
        Request withdrawal
      </button>
      {queued && !ledgerApi.onChain && (
        <p className="text-xs leading-5 text-faint">
          {fromBot
            ? "A queued claim pays once the bot has returned enough USDC. The deadline is 48 hours in the design and ten epochs here."
            : "Recall claims wait for the operator to return USDC, with a 48-hour deadline."}
        </p>
      )}
    </form>
  );
}

function Tickets() {
  const { walletId } = useIdentity();
  const ledgerApi = useLedger();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!ledgerApi.ready || !walletId) return null;
  const user = getUser(ledgerApi.ledger, walletId);
  const price = sharePrice(ledgerApi.ledger.vault);

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col">
      {/* With no claims there is nothing to scroll, so the card ends at this line. */}
      {user.withdrawals.length === 0 ? (
        <p className="border-t border-line pt-3 text-sm text-faint">No pending claims.</p>
      ) : (
        <ScrollBox size="fill" className="border-t border-line">
          <ul>
            {user.withdrawals.map((withdrawal) => {
              const payout = withdrawal.usdc ?? withdrawal.shares * price;
              const isDeposit = withdrawal.id.startsWith("deposit:");
              return (
                <li
                  key={withdrawal.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3"
                >
                  <div>
                    <p className="font-mono tabular-nums">{formatUsd(payout)}</p>
                    <p className="text-xs text-faint">
                      {withdrawal.note ??
                        (withdrawal.settlement === "instant" ? "Idle buffer" : "Awaiting recall")}{" "}
                      · {formatWhen(withdrawal.requestedAt)} UTC
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={withdrawal.claimable === false}
                    onClick={async () => {
                      if (!ledgerApi.ready || !walletId) return;
                      const result = await ledgerApi.claim(walletId, withdrawal.id);
                      if (!result.ok) {
                        setError(result.error);
                        setNotice(null);
                        return;
                      }
                      setError(null);
                      setNotice(
                        isDeposit
                          ? "Shares claimed into your wallet."
                          : `Claimed ${formatUsd(payout)} into ${ledgerApi.onChain ? "your wallet" : "guest USDC"}.`,
                      );
                    }}
                    className="rounded-full bg-brass px-4 py-2 text-sm font-medium text-brass-ink hover:bg-[#f0c56e] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isDeposit ? "Claim shares" : "Claim"}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollBox>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="mt-3 text-sm text-sage">{notice}</p>}
    </div>
  );
}

function AmountField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0.00"
        className="w-full rounded-xl border border-line bg-ink px-3 py-3 pr-16 font-mono text-lg text-paper outline-none placeholder:text-faint focus:border-brass"
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint">
        USDC
      </span>
    </div>
  );
}

function PositionCard() {
  const { walletId } = useIdentity();
  const ledgerApi = useLedger();
  if (!ledgerApi.ready) return null;
  const user = walletId ? getUser(ledgerApi.ledger, walletId) : null;
  const price = sharePrice(ledgerApi.ledger.vault);
  const openValue = user ? user.shares * price : 0;
  const queuedValue = user
    ? user.withdrawals.reduce((sum, item) => sum + (item.usdc ?? item.shares * price), 0)
    : 0;

  return (
    <section className="rounded-2xl border border-line bg-sheet px-5 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-4">
      <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Position</h2>
      {!walletId || !user ? (
        <p className="mt-3 text-sm text-muted">
          Connect a wallet to see shares and {ledgerApi.onChain ? "USDC" : "guest USDC"}.
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-4">
          <Stat label={ledgerApi.onChain ? "Wallet USDC" : "Guest USDC"} value={formatUsd(user.cash)} />
          <Stat label="Position" value={formatUsd(openValue + queuedValue)} />
          <Stat label="Available" value={formatShares(user.shares)} />
          <Stat label="Queued" value={formatUsd(queuedValue)} />
        </dl>
      )}
      {walletId && (
        <p className="mt-4 font-mono text-xs text-faint">{formatWallet(walletId)}</p>
      )}
    </section>
  );
}

function ActivityCard() {
  const { walletId } = useIdentity();
  const ledgerApi = useLedger();
  if (!ledgerApi.ready) return null;
  const activity = walletId ? getUser(ledgerApi.ledger, walletId).activity : [];

  return (
    <section className="rounded-2xl border border-line bg-sheet px-5 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-4">
      <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Activity</h2>
      {activity.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Deposits and withdrawals will show up here.</p>
      ) : (
        <ScrollBox className="mt-3">
          <table className="w-full text-left text-sm">
            <thead className={`font-mono text-[11px] tracking-[0.14em] text-faint uppercase ${STICKY_HEAD}`}>
              <tr>
                <th className="py-2 font-normal">Type</th>
                <th className="py-2 font-normal">Time (UTC)</th>
                <th className="py-2 font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((item) => (
                <tr key={item.id} className="border-t border-line">
                  <td className="py-2">{activityLabel(item.kind)}</td>
                  <td className="py-2 text-muted">{formatWhen(item.at)}</td>
                  <td className="py-2 font-mono tabular-nums">{formatUsd(item.usdc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-paper">{value}</dd>
    </div>
  );
}

function activityLabel(kind: ActivityKind): string {
  if (kind === "deposit") return "Deposited";
  if (kind === "request") return "Withdrawal requested";
  return "Claimed";
}
