# MouseTrap web

Staker app for the maker-rebate vault. Connect a Solana wallet, or use the preview wallet, then deposit, read your yield, and withdraw.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Where the money lives depends on what is running:

- **Nothing else:** deposits and withdrawals move preview USDC stored in the browser.
- **The bot in test mode** (`cd bot && npm run test-mode`): the bot's simulated vault, with fake USDC.
- **The bot in chain mode** (see [bot/README.md](../bot/README.md#chain-mode)): the [escrow program](../escrow) on a local validator. Your wallet signs every deposit, withdrawal and claim, and "Get test USDC" funds it. `src/lib/chain.ts` builds the transactions from the IDL in `src/lib/idl/`, which `cd bot && npm run idl:sync` keeps current.
