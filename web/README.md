# MouseTrap web

Staker app for the maker-rebate vault. Connect a Solana wallet, or use the preview wallet, then deposit, read your yield, and withdraw.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Deposits and withdrawals move preview USDC stored in the browser. Wallet tokens stay put: the app is not connected to the [escrow program](../escrow) yet.
