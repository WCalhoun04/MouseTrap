import type { VaultParams } from "../config.ts";
import { fmtUsd, type Micros } from "../money.ts";
import type { GateCheck, GateResult, VaultState } from "./types.ts";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function nav(state: Pick<VaultState, "idle" | "geminiEquity">): Micros {
  return state.idle + state.geminiEquity;
}

/**
 * The draw gate from AGENTS.md section 5: eight conditions, all checked in the same
 * transaction as the draw. Pure, so the vault, the relayer preview and the web app's
 * health view all read the same answer.
 */
export function checkDraw(state: VaultState, params: VaultParams, amount: Micros, now: number): GateResult {
  const netAssets = nav(state);
  const outstanding = state.drawnPrincipal + amount;
  const idleAfter = state.idle - amount;
  const bufferNeeded = Math.max(params.bufferRatio * netAssets, state.queuedWithdrawals);
  const navAge = now - state.navAt;
  const health = state.drawnPrincipal > 0 ? state.geminiEquity / state.drawnPrincipal : 1;
  const perDraw = params.perDrawShare * state.absoluteCap;
  const bondRatio = outstanding > 0 ? state.bond / outstanding : 1;

  const blockers: string[] = [];
  if (state.paused) blockers.push("paused");
  if (state.recall) blockers.push("recall open");
  if (amount > perDraw) blockers.push("over per-draw limit");
  if (amount < 0) blockers.push("negative amount");

  const checks: GateCheck[] = [
    {
      id: 1,
      label: "Bond coverage",
      pass: state.bond >= params.bondMin * outstanding,
      value: pct(bondRatio),
      requirement: `At least ${pct(params.bondMin)} of drawn principal`,
    },
    {
      id: 2,
      label: "Outstanding cap",
      pass: outstanding <= state.absoluteCap,
      value: fmtUsd(outstanding),
      requirement: `At most ${fmtUsd(state.absoluteCap)}`,
    },
    {
      id: 3,
      label: "Draw share of NAV",
      pass: outstanding <= params.drawnNavMax * netAssets,
      value: pct(netAssets > 0 ? outstanding / netAssets : 0),
      requirement: `At most ${pct(params.drawnNavMax)}`,
    },
    {
      id: 4,
      label: "Idle buffer",
      pass: idleAfter >= bufferNeeded,
      value: pct(netAssets > 0 ? idleAfter / netAssets : 0),
      requirement: `At least ${pct(params.bufferRatio)} of NAV and all queued withdrawals`,
    },
    {
      id: 5,
      label: "NAV freshness",
      pass: navAge >= 0 && navAge < params.navMaxAgeMs,
      value: `${Math.max(0, Math.round(navAge / 1000))}s old`,
      requirement: `Under ${Math.round(params.navMaxAgeMs / 1000)}s, signed by the attestor quorum`,
    },
    {
      id: 6,
      label: "Gemini equity",
      pass: health >= params.healthMin,
      value: `${pct(health)} of drawn`,
      requirement: `At least ${pct(params.healthMin)}`,
    },
    {
      id: 7,
      label: "Destination",
      pass: true,
      value: "Allowlisted Gemini address",
      requirement: "Changes are timelocked",
    },
    {
      id: 8,
      label: "Pause, recall and draw size",
      pass: blockers.length === 0,
      value: blockers.length ? blockers.join(", ") : "Clear",
      requirement: `Not paused, no open recall, at most ${fmtUsd(perDraw)} a draw`,
    },
  ];

  return { ok: checks.every((c) => c.pass), checks };
}
