"use client";

import { useEffect, useState } from "react";
import { PageLoader } from "@/components/page-loader";
import { ScrollBox, STICKY_HEAD } from "@/components/scroll-box";
import { useLedger } from "@/components/providers";
import {
  BOT_URL,
  fetchBot,
  type BotStatus,
  type Usage,
} from "@/lib/bot-api";
import { formatCents, formatClock, formatUsd } from "@/lib/format";

const POLL_MS = 1_000;

function useBotStatus(): { status: BotStatus | null; loaded: boolean } {
  const [state, setState] = useState<{ status: BotStatus | null; loaded: boolean }>({
    status: null,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    let misses = 0;
    const poll = async () => {
      const next = await fetchBot();
      if (cancelled) return;
      if (next) {
        misses = 0;
        setState({ status: next, loaded: true });
      } else {
        misses += 1;
        // The first miss settles "is it running?"; after that, ride out a dropped poll or two.
        setState((prev) => (prev.loaded && misses < 3 ? prev : { status: null, loaded: true }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}

export function OperatorScreen() {
  const { status, loaded } = useBotStatus();
  const ledgerApi = useLedger();

  if (!loaded) {
    return <PageLoader />;
  }

  if (!status) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-serif text-4xl tracking-tight">Operator</h1>
        <div className="mt-4 rounded-2xl border border-line bg-sheet p-5 sm:p-6">
          <h2 className="font-serif text-2xl">The bot is not running</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            This view shows the market maker&apos;s quotes, fills and draws. Start the bot
            and this page fills in within a few seconds. It quotes against live Gemini order
            books.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-ink p-4 font-mono text-sm text-paper">
            cd bot{"\n"}npm install{"\n"}npm run test-mode
          </pre>
          <p className="mt-3 text-sm text-faint">
            Looking for it at <span className="font-mono">{BOT_URL}</span>. Add{" "}
            <span className="font-mono">-- --offline</span> to run on a generated market with no
            network.
          </p>
        </div>
      </div>
    );
  }

  const bot = ledgerApi.ready ? ledgerApi.bot : null;
  const vault = ledgerApi.ready ? ledgerApi.ledger.vault : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">Operator</h1>
          {/* Shown only while quotes are pulled or reduced, to say why. */}
          {status.killReason && (
            <p className="mt-2 max-w-2xl text-sm leading-6 text-danger">{status.killReason}.</p>
          )}
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Total PnL" value={formatUsd(status.pnl.total)} tone={status.pnl.total} />
        <Figure label="Rebates paid" value={formatUsd(status.pnl.rebate)} />
        <Figure label="Spread" value={formatUsd(status.pnl.spread)} tone={status.pnl.spread} />
        <Figure label="Drawn principal" value={vault ? formatUsd(vault.drawnPrincipal) : "—"} />
      </section>

      <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Quotes</h2>
        <ScrollBox size="lg" className="mt-3">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className={`font-mono text-[11px] tracking-[0.14em] text-faint uppercase ${STICKY_HEAD}`}>
              <tr>
                <th className="py-2 font-normal">Contract</th>
                <th className="py-2 font-normal">Market</th>
                <th className="py-2 font-normal" title="Our bid">Bid</th>
                <th className="py-2 font-normal" title="Our ask">Ask</th>
                <th className="py-2 font-normal" title="Position">Pos</th>
              </tr>
            </thead>
            <tbody>
              {status.contracts.map((c) => (
                <tr key={c.symbol} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <p className="text-paper">{c.title}</p>
                    <p className="font-mono text-[11px] text-faint">
                      {c.category}
                      {c.note ? ` · ${c.note}` : ""}
                      {c.rewardEligible ? " · reward-eligible" : ""}
                    </p>
                  </td>
                  <td className="py-2 font-mono tabular-nums text-muted">
                    {formatCents(c.marketBid)} / {formatCents(c.marketAsk)}
                  </td>
                  <td className="py-2 font-mono tabular-nums">
                    {c.ourBid ? `${c.ourBid.qty} @ ${formatCents(c.ourBid.price)}` : "—"}
                  </td>
                  <td className="py-2 font-mono tabular-nums">
                    {c.ourAsk ? `${c.ourAsk.qty} @ ${formatCents(c.ourAsk.price)}` : "—"}
                  </td>
                  <td
                    className={`py-2 font-mono tabular-nums ${
                      c.position === 0 ? "text-faint" : "text-paper"
                    }`}
                  >
                    {c.position > 0 ? `+${c.position}` : c.position}
                  </td>
                </tr>
              ))}
              {status.contracts.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={5} className="py-3 text-muted">
                    No contract currently has a two-sided book inside the rebate band.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollBox>
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Recent fills
          </h2>
          <ScrollBox className="mt-2">
            {status.fills.length === 0 ? (
              <p className="pt-1 text-sm leading-6 text-muted">
                No fills yet. A paper quote fills when a trade reaches its price, or when the
                market moves through it.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {status.fills.map((fill) => (
                  <li key={fill.id} className="flex items-baseline justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {fill.side === "bid" ? "Bought" : "Sold"} {fill.qty} @{" "}
                        {formatCents(fill.price)}
                        {fill.simulated ? " · replayed volume" : ""}
                      </p>
                      <p className="truncate text-xs text-faint">
                        {fill.title} · {formatClock(fill.at)}
                      </p>
                    </div>
                    <p className="font-mono text-sm tabular-nums text-sage">
                      +{formatUsd(fill.rebate, 4)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </ScrollBox>
        </section>

        <section className="flex flex-col rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Edge</h2>
          {/* Rows spread to the card's height, which the Recent fills card beside it sets. */}
          <dl className="mt-4 flex flex-1 flex-col justify-between gap-3">
            <Row label="Fills" value={`${status.edge.fills} (${status.edge.contracts} contracts)`} />
            <Row label="Filled notional" value={formatUsd(status.edge.filledNotional)} />
            <Row label="Rebate per $ filled" value={pct(status.edge.rebatePerDollar)} />
            <Row label="Net edge, fee waiver" value={pct(status.edge.trailingEdge)} />
            <Row label="Net edge, post-waiver" value={pct(status.edge.trailingEdgePostWaiver)} />
            <Row label="Markout at fill" value={cents(status.markouts.atFill)} />
            <Row label="Markout 1 min" value={cents(status.markouts.m1)} />
            <Row label="Markout 5 min" value={cents(status.markouts.m5)} />
            <Row label="Hedge" value={status.hedger === "none" ? "Not built yet" : status.hedger} />
          </dl>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Draw gate
          </h2>
          {bot ? (
            <ul className="mt-2 divide-y divide-line">
              {bot.gate.checks.map((check) => (
                <li
                  key={check.id}
                  className="grid gap-1 py-2 sm:grid-cols-[1.1fr_1fr_auto] sm:items-center sm:gap-4"
                >
                  <p className="text-sm text-paper">{check.label}</p>
                  <p className="font-mono text-sm text-muted">{check.value}</p>
                  <p className={`font-mono text-xs ${check.pass ? "text-sage" : "text-danger"}`}>
                    {check.pass ? "Pass" : "Fail"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">Waiting for vault state.</p>
          )}
          <dl className="mt-4 space-y-3 border-t border-line pt-4">
            <Row label="Requested Capital" value={formatUsd(status.relayer.capitalWanted)} />
            <Row label="Trading Capital" value={formatUsd(status.exchange.cash)} />
            <Row
              label="Draws"
              value={status.relayer.drawsAllowed ? "Allowed" : (status.relayer.drawBlockReason ?? "Held")}
            />
            {bot?.recall && (
              <Row
                label="Recall outstanding"
                value={formatUsd(Math.max(0, bot.recall.amount - bot.recall.repaid))}
              />
            )}
          </dl>
        </section>

        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Risk limits
          </h2>
          <ul className="mt-4 space-y-4">
            <Meter label="Net inventory" usage={status.limits.net} />
            <Meter label="Largest contract" usage={status.limits.perContract} />
            <Meter label="Largest event" usage={status.limits.perEvent} />
            <Meter label="Largest category" usage={status.limits.perCategory} />
          </ul>
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
          Relayer and bot log
        </h2>
        <ScrollBox className="mt-2">
          {status.log.length === 0 ? (
            <p className="pt-1 text-sm text-muted">Nothing logged yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {status.log.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex items-baseline gap-3 py-2">
                  <span className="shrink-0 font-mono text-xs text-faint">
                    {formatClock(entry.at)}
                  </span>
                  <span className="text-sm">{entry.text}</span>
                </li>
              ))}
            </ul>
          )}
        </ScrollBox>
      </section>
    </div>
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function cents(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}¢`;
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const color = tone === undefined || tone === 0 ? "" : tone > 0 ? "text-sage" : "text-danger";
  return (
    <div className="rounded-2xl border border-line bg-sheet p-4">
      <p className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">{label}</p>
      <p className={`mt-2 font-serif text-2xl tabular-nums sm:text-3xl ${color}`}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function Meter({ label, usage }: { label: string; usage: Usage }) {
  const share = usage.max > 0 ? Math.min(1, usage.used / usage.max) : 0;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">{label}</p>
        <p className="font-mono text-sm tabular-nums">
          {usage.used} / {usage.max}
        </p>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={usage.max}
        aria-valuenow={usage.used}
      >
        <div
          className={`h-full rounded-full ${share >= 0.9 ? "bg-danger" : "bg-brass"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </li>
  );
}
