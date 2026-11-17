# MouseTrap market maker bot

The market maker and draw relayer from [AGENTS.md](../AGENTS.md) sections 5 and 6. It quotes tight two-sided markets on Gemini Predictions to earn maker rebates, and draws its capital from the escrow vault through the draw gate.

By default the bot runs against a simulated vault that implements the same instructions and the same eight gate conditions as the escrow program in [`../escrow`](../escrow). With `--chain` it uses the program itself on a local Solana validator (see [Chain mode](#chain-mode)).

## Run it

Needs Node 22.4 or newer.

```
cd bot
npm install
npm run test-mode
```

Then, in another terminal, start the web app (`cd web && npm install && npm run dev`) and open http://localhost:3000. The Vault, Health and Operator pages switch from the browser's mock ledger to the bot as soon as it answers.

| Command | Market | Funds | Needs |
| --- | --- | --- | --- |
| `npm run test-mode` | Live Gemini order books, paper fills | Fake USDC | Internet |
| `npm run test-mode -- --offline` | Generated books and takers | Fake USDC | Nothing |
| `npm run demo` | Gemini sandbox, real orders | Sandbox funds | Sandbox API key in `.env` (`GEMINI_NONCE` must match the key) |
| `npm run live` | Gemini production | Real money | API key, `MODE=live`, `I_UNDERSTAND_LIVE_TRADING=yes` |

`npm test` runs the unit tests. `npm run typecheck` checks types.

## Test mode

- **No order reaches Gemini.** Quotes live in memory. A quote fills when the real market trades through its price, or at its price once the size that was ahead of it has traded.
- **If Gemini cannot be reached**, the bot says so and runs on the generated market. The web banner shows which one is in use.
- **A day takes a minute.** `EPOCH_SECONDS` (default 60) stands in for the daily cycle: rebate payout, NAV report, epoch settlement, profit sweep. NAV freshness and recall deadlines are scaled to match.
- **The vault starts small** (20,000 fake USDC from other stakers, a 4,000 bond) so that rebates on thin books still move the share price. Each wallet gets 25,000 fake USDC.
- **Each epoch replays one real day of volume.** Gemini's books are too thin to watch in real time, so for every contract the bot quotes, test mode spreads that contract's real 24-hour USD volume across the epoch as taker orders against the live top of book (`src/exchange/dayFlow.ts`). PnL and rebates per epoch then approximate one real day. Those fills are labelled "simulated taker". Set `DAY_FLOW=off` to fill only on real trades.
- **What is data and what is assumed.** Prices, spreads, volumes and the rebate formula are Gemini's. Three numbers are assumptions you can change in `.env`: half the taker flow reaches the bot (`CAPTURE_SHARE`), 30% of takers are informed (`INFORMED_SHARE`), and an informed fill costs 2 cents a contract (`INFORMED_MOVE_CENTS`). Gemini publishes volume per event only, so it is split evenly across the event's contracts. Phase 0 exists to replace these assumptions with measurements.
- **Price moves count against the bot.** When the live price moves through a resting quote, the quote fills at its old price, as it would on the exchange.
- **State is in memory.** Restarting the bot starts over. Fills are appended to `data/fills-<date>.jsonl`.

The Operator page has three test controls: force a recall, pause draws, and cancel all quotes. A forced recall is the quickest way to show the escrow working: the bot cancels its quotes, repays free cash at once, and works out of inventory to repay the rest.

The local API listens on `127.0.0.1:8787` with no authentication and only runs in test mode.

### Chain mode

Runs the same test mode, but every draw, repayment, profit sweep, NAV report and epoch settlement is a transaction on the escrow program. Needs the Solana CLI and the program built with `cd escrow && anchor build --arch v0`.

```
npm run localnet                        # terminal 1: validator with the program loaded (resets each start)
npm run localnet:setup                  # terminal 2: test USDC, keys, initialise, bond, seed deposit
npm run test-mode -- --chain --offline  # terminal 2: the bot (drop --offline for live Gemini books)
```

- Keys and the validator ledger live in `bot/.localnet/` (gitignored). The setup script takes the vault limits from the test-mode config, so the bot's gate preview and the program agree.
- The bot holds the operator, attestor (single-key quorum) and sentinel keys, and acts as the epoch crank.
- The first draws are held back until the first settlement, because the seed deposit only counts toward NAV once its shares mint.
- Paper profit has no USDC behind it, so before a repayment or sweep the bot mints any shortfall into the Gemini stand-in account. This only happens on a local validator.
- The web app stakes with your wallet in chain mode. Connect Phantom or Solflare, press "Get test USDC" (2 SOL and 25,000 test USDC from the bot's faucet), then deposit. Shares mint when the epoch settles, about a minute later: claim them under the form. Withdrawals work the same way: request, wait for the settlement, claim. The preview wallet does not work in chain mode.
- The app sends transactions to the local validator itself; the wallet only signs. If Phantom warns that a transaction may fail, switch it to Solana Localnet (Settings, Developer Settings, Testnet Mode) so it can simulate against the same chain.
- `SOLANA_RPC_URL` (default `http://127.0.0.1:8899`) picks the validator. After changing the program, run `npm run idl:sync`.

### Market maker dashboard

Test mode also serves a dashboard for demos at http://localhost:8788 (`DASHBOARD_PORT`). It shows the live order tape (every order placed, cancelled, filled or rejected), the quote board, PnL and rebates per simulated day, annualised return on drawn capital, the draw gate and the relayer log. It is one self-contained page, `src/server/dashboard.html`, and its port is read-only: it has no routes that move funds or trigger the sentinel controls.

## What is real and what is not

| Part | Status |
| --- | --- |
| Quoting, risk limits, kill switch, order management | Built and unit-tested |
| Rebate maths | Built; reproduces Gemini's worked examples in AGENTS.md section 2 |
| Draw gate, simulated vault, relayer | Built and unit-tested |
| Live Gemini market data | Built; checked against the production API on 2026-11-16 |
| Real orders (`src/exchange/gemini.ts`) | Place, maker-or-cancel rejection, cancel and cancel-all checked in the Gemini sandbox on 2026-11-16. Fill tracking from the order WebSocket is not yet seen working |
| Delta hedging | Not built. `Hedger` interface with a no-op; hedge PnL shows as zero |
| Liquidity rewards | Not modelled. Quotes are flagged when they meet the rules, but no reward is booked |
| On-chain escrow (`src/vault/chain.ts`) | Built for a local validator: draws, repayments, sweeps, NAV, settlement, breakers. Tested end to end by hand |
| Real USDC transfers between Gemini and the vault | Not built. On a local validator a token account stands in for Gemini; bookkeeping only in demo and live |
| Attestors | Not built. The bot signs NAV with a single attestor key |
| Operator performance fee | On-chain only (20% above a high-water mark). The simulated vault shows the full share-price change |

Two shortcuts in the simulated vault differ from the design: deposits mint shares at the current price, not the next epoch's, and instant withdrawals can be claimed without waiting for the epoch to settle. The on-chain vault has neither shortcut.

In demo and live mode the daily cycle runs on a fixed interval from start-up, not at 5pm ET.

## Layout

```
src/
  cli.ts                 entry point and wiring
  bot.ts                 quoting loop, epoch cycle, operator status
  config.ts              every limit and default, by mode
  exchange/
    types.ts             Exchange and MarketFeed interfaces
    paper.ts             paper account on top of a market feed
    geminiFeed.ts        public Gemini books and trades (no API key)
    synthetic.ts         generated market for offline runs
    gemini.ts            real orders through the Gemini SDK
  strategy/              rebate maths, contract selection, quoting
  risk/                  exposure caps, collateral, kill switch
  execution/             order manager
  pnl/                   fill log, markouts, PnL attribution
  vault/                 VaultClient interface, draw gate, simulated vault
    chain.ts             the escrow program as a VaultClient (and NAV/epoch crank)
    idl/                 IDL and types copied from escrow/target by `npm run idl:sync`
  chain/localnet.ts      local validator keys and setup output
  relayer/               draw, repay and sweep; treasury (the money path)
  server/http.ts         local API for the web app
scripts/localnet-setup.ts  initialises the vault on a local validator
```
