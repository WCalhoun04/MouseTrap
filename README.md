# Mouse Trap

A maker-rebate vault: stakers deposit USDC on Solana, and an operator draws it, under on-chain rules, to quote tight two-sided markets on Gemini Predictions. Stakers earn the maker rebates plus any spread kept, minus losses and fees. [AGENTS.md](AGENTS.md) has the full design.

| Folder | What it is | Run it |
| --- | --- | --- |
| [`escrow/`](escrow) | Anchor program: vault, mvUSDC shares, draw gate, attested NAV, breakers | `anchor build --arch v0 && cargo test` |
| [`bot/`](bot) | Market maker bot and draw relayer, with a simulated vault for test mode | `npm install && npm run test-mode` |
| [`web/`](web) | Staker app: Vault, Health and Operator pages | `npm install && npm run dev` |

Start the bot first, then the web app: the web pages read live state from the bot when it is running and fall back to a browser-only preview when it is not.

The bot and the web app do not use the escrow program yet; both run against the simulated vault.
