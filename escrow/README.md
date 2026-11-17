# MouseTrap escrow program

The on-chain vault from [AGENTS.md](../AGENTS.md) sections 4 and 5: an Anchor program that holds staker USDC, issues mvUSDC shares at a daily epoch price, and releases USDC to the one allowlisted Gemini address only through the eight-condition draw gate.

## Build and test

Needs Anchor 1.2 and the Solana CLI 3.1.

```
cd escrow
anchor build --arch v0
cargo test
```

Use `--arch v0`: Anchor 1.2 builds SBPF v3 by default, and LiteSVM (the test runtime) cannot load v3 programs yet. Rebuild before `cargo test` after any change to `src/`, because the tests load `target/deploy/mousetrap_vault.so`.

The tests in `programs/mousetrap_vault/tests/vault.rs` run in LiteSVM, with a local USDC mint and the clock moved forward as needed:

| Test | Covers |
| --- | --- |
| `full_lifecycle_deposit_draw_profit_withdraw` | Deposit, settle, claim shares, draw, rebates swept home, performance fee, withdrawal that triggers a recall, repay, claim, fee shares |
| `breaker_slashes_bond_then_missed_recall_slashes_the_rest` | Equity below 90% slashes the bond and opens a recall; a missed deadline slashes the rest and pauses |
| `nav_needs_a_quorum_of_distinct_attestors` | ed25519 quorum (run as 2-of-3), outsiders, duplicate signers, forged reports, replay, future timestamps |
| `draw_gate_conditions` | Each gate condition, wrong destination, wrong signer, sentinel-only pause, bond release limits |
| `silent_attestors_open_a_recall` | No NAV for 24 hours opens a recall |
| `deposits_wait_for_the_epoch_price` | Shares mint only after settlement |

## Deploy to a local validator

```
solana-test-validator --reset          # separate terminal
solana config set --url localhost
anchor deploy --provider.cluster localnet
```

The program ID comes from `target/deploy/mousetrap_vault-keypair.json`. That file is gitignored, so back it up: losing it means a new program ID.

## Scope

Built to the hackathon scope in AGENTS.md section 5: owner, operator, sentinel, attestors and the Gemini destination are fixed at `initialize`, and no instruction changes them. The attestor set and quorum are settings, so a single attestor is `attestor_count: 1, quorum: 1`, and 2-of-3 later needs no program change.

Other differences from AGENTS.md:

- One vault per program: every account is a fixed-seed PDA.
- Draws emit a `Drawn` event in place of a `DrawTicket` account.
- The latest NAV report is stored on `VaultState`; past reports exist only as `NavSubmitted` events.
- The performance fee uses a high-water mark with no hurdle rate.
- When the breaker slashes the bond, the slashed amount reduces outstanding principal. A slash for a missed deadline is a penalty and does not.
