"use client";

import { useIdentity, useLedger } from "@/components/providers";
import { formatAge, formatClock, formatDate, formatPct, formatUsd, formatWhen } from "@/lib/format";
import {
  BOND_MIN,
  BUFFER_RATIO,
  dailyBook,
  DRAWN_NAV_MAX,
  HEALTH_MIN,
  readings,
} from "@/lib/ledger";

export function HealthScreen() {
  const identity = useIdentity();
  const ledgerApi = useLedger();

  if (!identity.ready || !ledgerApi.ready) {
    return <p className="px-4 py-16 text-sm text-muted sm:px-6">Loading health…</p>;
  }

  const { ledger, now, bot } = ledgerApi;
  const local = readings(ledger.vault, now);
  const view = bot ? { ...local, epoch: bot.epoch, navAt: bot.navAt, instantRoom: bot.instantRoom } : local;
  const vault = ledger.vault;
  const previewGates = [
    {
      label: "Bond coverage",
      value: formatPct(view.bondRatio).replace("+", ""),
      requirement: `At least ${formatPct(BOND_MIN).replace("+", "")} of drawn principal`,
      pass: view.bondRatio >= BOND_MIN,
    },
    {
      label: "Outstanding cap",
      value: formatUsd(vault.drawnPrincipal),
      requirement: `At most ${formatUsd(vault.absoluteCap)}`,
      pass: vault.drawnPrincipal <= vault.absoluteCap,
    },
    {
      label: "Draw share of NAV",
      value: formatPct(view.drawnRatio).replace("+", ""),
      requirement: `At most ${formatPct(DRAWN_NAV_MAX).replace("+", "")}`,
      pass: view.drawnRatio <= DRAWN_NAV_MAX,
    },
    {
      label: "Idle buffer",
      value: formatPct(view.idleRatio).replace("+", ""),
      requirement: `At least ${formatPct(BUFFER_RATIO).replace("+", "")} of NAV`,
      pass: view.idleRatio >= BUFFER_RATIO,
    },
    {
      label: "NAV freshness",
      value: formatAge(view.navAt, now),
      requirement: "Under 1 hour",
      pass: now - local.navAt < 60 * 60 * 1000,
    },
    {
      label: "Gemini equity",
      value: formatPct(view.health).replace("+", "") + " of drawn",
      requirement: `At least ${formatPct(HEALTH_MIN).replace("+", "")}`,
      pass: view.health >= HEALTH_MIN,
    },
    {
      label: "Destination",
      value: "Allowlisted Gemini address",
      requirement: "Changes are timelocked",
      pass: true,
    },
    {
      label: "Pause",
      value: vault.paused ? "Paused" : "Not paused",
      requirement: "Draws allowed",
      pass: !vault.paused,
    },
  ];
  // One test epoch moves 1,000 shares by fractions of a cent, so show more digits.
  const digits = bot ? 4 : 2;
  // With the bot running, the gate is the one its simulated escrow enforces on every draw.
  const gates = bot ? bot.gate.checks : previewGates;
  const book = bot ? bot.bookings : dailyBook(now, 7);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">Vault health</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            {bot
              ? "These readings come from the simulated escrow the bot draws from. It enforces the same eight draw-gate conditions as the on-chain design, with the time limits scaled to the epoch length."
              : "These readings follow the draw-gate rules. They are computed in the preview until attestors sign a NAV report on-chain."}
          </p>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="NAV" value={formatUsd(view.nav)} />
        <Figure label="Drawn principal" value={formatUsd(vault.drawnPrincipal)} />
        <Figure label="Operator bond" value={formatUsd(vault.bond)} />
        <Figure label="Idle USDC" value={formatUsd(vault.idleUsdc)} />
      </section>

      <section className="grid gap-4 lg:grid-cols-5">
        <div className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-3">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Draw gate
          </h2>
          <ul className="mt-2 divide-y divide-line">
            {gates.map((gate) => (
              <li key={gate.label} className="grid gap-1 py-3 sm:grid-cols-[1.1fr_1fr_auto] sm:items-center sm:gap-4">
                <p className="text-sm text-paper">{gate.label}</p>
                <p className="font-mono text-sm text-muted">{gate.value}</p>
                <p className={`font-mono text-xs ${gate.pass ? "text-sage" : "text-danger"}`}>
                  {gate.pass ? "Pass" : "Fail"}
                  <span className="mt-1 block font-sans text-faint normal-case tracking-normal sm:hidden">
                    {gate.requirement}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-line bg-sheet p-5 sm:p-6 lg:col-span-2">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
            Latest NAV
          </h2>
          <dl className="mt-4 space-y-4">
            <Row
              label="Reported"
              value={bot ? formatAge(view.navAt, now) : `${formatWhen(view.navAt)} UTC`}
            />
            <Row label="Gemini equity" value={formatUsd(vault.geminiEquity)} />
            <Row label="Attestors" value={bot ? "Bot stand-in" : "2 of 3"} />
            <Row label="Epoch" value={String(view.epoch)} />
            <Row label="Idle room for claims" value={formatUsd(view.instantRoom)} />
            {bot?.recall && (
              <Row
                label="Recall outstanding"
                value={formatUsd(Math.max(0, bot.recall.amount - bot.recall.repaid))}
              />
            )}
          </dl>
          <p className="mt-4 text-sm leading-6 text-faint">
            {bot
              ? "The bot reads its own paper account and posts NAV itself. The design has three independent attestors and a 2 of 3 quorum."
              : "A positions hash will show here when attestors post the report. The quorum in the design is 2 of 3."}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-sheet p-5 sm:p-6">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">
          {bot ? "Booking per epoch, per 1,000 mvUSDC" : "Seven-day booking per 1,000 mvUSDC"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {bot
            ? `Each row is one ${bot.epochSeconds}-second epoch, standing in for a day: the rebate payout, then spread marked to mid, on 1,000 shares.`
            : "Each row is that day's share-price change on 1,000 shares, split the same way as personal yield."}
        </p>
        {bot && book.length === 0 && (
          <p className="mt-4 text-sm text-faint">The first epoch has not settled yet.</p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
              <tr>
                <th className="py-2 font-normal">{bot ? "Epoch" : "Day"}</th>
                <th className="py-2 font-normal">Rebates</th>
                <th className="py-2 font-normal">Rewards</th>
                <th className="py-2 font-normal">Spread</th>
                <th className="py-2 text-right font-normal">Net</th>
              </tr>
            </thead>
            <tbody>
              {book.map((row) => (
                <tr key={row.t} className="border-t border-line font-mono tabular-nums">
                  <td className="py-2 font-sans text-muted">
                    {bot ? `${"epoch" in row ? row.epoch : ""} · ${formatClock(row.t)}` : formatDate(row.t)}
                  </td>
                  <td className="py-2">{formatUsd(row.rebates, digits)}</td>
                  <td className="py-2">{formatUsd(row.rewards, digits)}</td>
                  <td className={`py-2 ${row.spread < 0 ? "text-danger" : ""}`}>
                    {formatUsd(row.spread, digits)}
                  </td>
                  <td className={`py-2 text-right ${row.net < 0 ? "text-danger" : "text-sage"}`}>
                    {formatUsd(row.net, digits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-sheet p-4">
      <p className="font-mono text-[11px] tracking-[0.16em] text-faint uppercase">{label}</p>
      <p className="mt-2 font-serif text-2xl tabular-nums sm:text-3xl">{value}</p>
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
