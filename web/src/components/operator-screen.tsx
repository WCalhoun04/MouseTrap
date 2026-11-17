"use client";

import { useEffect, useState } from "react";
import { useLedger } from "@/components/providers";
import {
  botActions,
  BOT_URL,
  fetchBot,
  sourceLabel,
  type ActionResult,
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
  const [message, setMessage] = useState<string | null>(null);

  if (!loaded) {
    return <p className="px-4 py-16 text-sm text-muted sm:px-6">Looking for the bot…</p>;
  }

  if (!status) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-serif text-4xl tracking-tight">Operator</h1>
        <div className="mt-4 rounded-2xl border border-line bg-sheet p-5 sm:p-6">
          <h2 className="font-serif text-2xl">The bot is not running</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            This view shows the market maker&apos;s quotes, fills and draws. Start the bot in
            test mode and this page fills in within a few seconds. Test mode trades fake funds
            against live Gemini order books.
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
  const run = async (action: Promise<ActionResult>, done: string) => {
    const result = await action;
    setMessage(result.ok ? done : result.error);
  };

  const modeLabel =
    status.quoteMode === "normal"
      ? "Quoting"
      : status.quoteMode === "reduce-only"
        ? "Reduce only"
        : "Quotes pulled";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">Operator</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            {sourceLabel(status)}. Every order is maker-or-cancel and sits inside the $0.20 to
            $0.80 rebate band.
            {status.killReason ? ` ${status.killReason}.` : ""}
          </p>
        </div>
        <p
          className={`rounded-full border px-3 py-1 font-mono text-xs tracking-[0.14em] uppercase ${
            status.quoteMode === "normal" ? "border-sage/40 text-sage" : "border-danger/40 text-danger"
          }`}
        >
          {modeLabel}
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Total PnL" value={formatUsd(status.pnl.total)} tone={status.pnl.total} />
        <Figure label="Rebates paid" value={formatUsd(status.pnl.rebate)} />
        <Figure label="Spread" value={formatUsd(status.pnl.spread)} tone={status.pnl.spread} />
        <Figure label="Drawn principal" value={vault ? formatUsd(vault.drawnPrincipal) : "—"} />
      </section>

      <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Quotes</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
              <tr>
                <th className="py-2 font-normal">Contract</th>
                <th className="py-2 text-right font-normal">Market</th>
                <th className="py-2 text-right font-normal">Our bid</th>
                <th className="py-2 text-right font-normal">Our ask</th>
                <th className="py-2 text-right font-normal">Position</th>
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
                  <td className="py-2 text-right font-mono tabular-nums text-muted">
                    {formatCents(c.marketBid)} / {formatCents(c.marketAsk)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {c.ourBid ? `${c.ourBid.qty} @ ${formatCents(c.ourBid.price)}` : "—"}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {c.ourAsk ? `${c.ourAsk.qty} @ ${formatCents(c.ourAsk.price)}` : "—"}
                  </td>
                  <td
                    className={`py-2 text-right font-mono tabular-nums ${
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
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Recent fills
          </h2>
          {status.fills.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-muted">
              No fills yet. A paper quote fills when a trade reaches its price, or when the
              market moves through it.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {status.fills.slice(0, 12).map((fill) => (
                <li key={fill.id} className="flex items-baseline justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {fill.side === "bid" ? "Bought" : "Sold"} {fill.qty} @{" "}
                      {formatCents(fill.price)}
                      {fill.simulated ? " · simulated taker" : ""}
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
        </section>

        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">Edge</h2>
          <dl className="mt-4 space-y-3">
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
          <p className="mt-4 text-sm leading-6 text-faint">
            Markouts are cents per contract; positive means the price moved the bot&apos;s way
            after the fill. The Phase 0 gate is positive post-waiver edge over 30 days.
          </p>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Draw gate preview
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
            <Row label="Capital the bot wants" value={formatUsd(status.relayer.capitalWanted)} />
            <Row label="Cash on exchange" value={formatUsd(status.exchange.cash)} />
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

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Test controls
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            These stand in for the sentinel and the operator&apos;s kill switch. They exist only
            in test mode.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Control
              onClick={() => run(botActions.recall(), "Recall opened. The bot is repaying.")}
              danger
            >
              Force recall
            </Control>
            {vault?.paused ? (
              <Control onClick={() => run(botActions.resume(), "Draws resumed.")}>
                Resume draws
              </Control>
            ) : (
              <Control onClick={() => run(botActions.pause(), "Draws paused.")} danger>
                Pause draws
              </Control>
            )}
            {status.manualStop ? (
              <Control onClick={() => run(botActions.startQuoting(), "Quoting resumed.")}>
                Resume quoting
              </Control>
            ) : (
              <Control onClick={() => run(botActions.stopQuoting(), "All quotes cancelled.")} danger>
                Cancel all quotes
              </Control>
            )}
          </div>
          {message && (
            <p role="status" className="mt-3 text-sm text-muted">
              {message}
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Relayer and bot log
          </h2>
          {status.log.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing logged yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {status.log.slice(0, 10).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex items-baseline gap-3 py-2">
                  <span className="shrink-0 font-mono text-xs text-faint">
                    {formatClock(entry.at)}
                  </span>
                  <span className="text-sm">{entry.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
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

function Control({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-sm ${
        danger
          ? "border-danger/40 text-danger hover:bg-danger/10"
          : "border-line text-paper hover:bg-sheet-2"
      }`}
    >
      {children}
    </button>
  );
}
