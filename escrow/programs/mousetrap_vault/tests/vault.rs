mod common;

use {
    anchor_lang::InstructionData,
    common::*,
    mousetrap_vault::{error::VaultError, instruction as ix, recall_reason},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const CONSTRAINT_ADDRESS: u32 = 2012;

#[test]
fn full_lifecycle_deposit_draw_profit_withdraw() {
    let mut env = Env::new();
    env.post_bond(usdc(2_000));
    let (staker, staker_usdc) = env.onboard(usdc(10_000));
    assert_eq!(env.shares_of(&staker.pubkey()), usdc(10_000));
    assert_eq!(env.balance(&env.pda.idle), usdc(10_000));

    env.post_nav(0);
    let ix = env.draw_ix(usdc(7_000));
    let op = env.operator.insecure_clone();
    env.send_err(&[ix], &[&op], err(VaultError::GateNavShare));
    env.draw(usdc(5_000)).unwrap();
    assert_eq!(env.balance(&env.gemini_usdc), usdc(5_000));
    assert_eq!(env.state().drawn_principal, usdc(5_000));

    // A day of rebates lands on Gemini; attestors see it; the relayer sweeps it home.
    let gemini_usdc = env.gemini_usdc;
    env.mint_to(&gemini_usdc, usdc(300));
    env.warp(600);
    env.post_nav(usdc(5_300));
    env.gemini_send(env.sweep_ix(usdc(300)));
    assert_eq!(env.state().gemini_equity, usdc(5_000));

    let shares = env.shares_of(&staker.pubkey());
    let epoch = env.state().epoch;
    let ix = env.request_withdraw_ix(&staker.pubkey(), shares);
    env.send_ok(&[ix], &[&staker]);
    assert_eq!(env.shares_of(&staker.pubkey()), 0);

    env.warp(3_001);
    env.post_nav(usdc(5_000));
    env.settle();

    // 300 of profit less the 20% performance fee.
    let state = env.state();
    let owed = state.reserved_withdrawals;
    assert!(owed > usdc(10_239) && owed < usdc(10_241), "owed {owed}");
    assert!(state.fee_shares_owed > 0);

    // Idle cannot cover the claim, so settlement raised a recall on the operator.
    assert!(state.recall.active);
    assert_eq!(state.recall.reason, recall_reason::WITHDRAWALS);
    let ix = env.claim_withdraw_ix(&staker.pubkey(), &staker_usdc, epoch);
    env.send_err(&[ix], &[&staker], err(VaultError::InsufficientIdle));

    env.gemini_send(env.repay_ix(usdc(5_000)));
    let state = env.state();
    assert!(!state.recall.active);
    assert_eq!(state.drawn_principal, 0);

    let ix = env.claim_withdraw_ix(&staker.pubkey(), &staker_usdc, epoch);
    env.send_ok(&[ix], &[&staker]);
    assert_eq!(env.balance(&staker_usdc), owed);

    let ix = env.claim_fees_ix(&env.operator.pubkey());
    env.send_ok(&[ix], &[&op]);
    assert!(env.shares_of(&env.fee_recipient.pubkey()) > 0);
    assert_eq!(env.state().fee_shares_owed, 0);
}

#[test]
fn breaker_slashes_bond_then_missed_recall_slashes_the_rest() {
    let mut env = Env::new();
    env.post_bond(usdc(2_000));
    env.onboard(usdc(10_000));
    env.post_nav(0);
    env.draw(usdc(5_000)).unwrap();

    // Equity at 80% of principal: below the 90% breaker.
    env.warp(60);
    env.post_nav(usdc(4_000));
    let state = env.state();
    assert_eq!(env.balance(&env.pda.bond), usdc(1_000));
    assert_eq!(env.balance(&env.pda.idle), usdc(6_000));
    assert_eq!(state.drawn_principal, usdc(4_000));
    assert!(state.recall.active);
    assert_eq!(state.recall.reason, recall_reason::BREAKER);

    let op = env.operator.insecure_clone();
    let ix = env.draw_ix(usdc(100));
    env.send_err(&[ix], &[&op], err(VaultError::GateRecallOpen));
    let ix = env.release_bond_ix(usdc(1));
    env.send_err(&[ix], &[&op], err(VaultError::BondLocked));
    let ix = env.slash_bond_ix();
    env.send_err(&[ix], &[&op], err(VaultError::ConditionNotMet));

    env.warp(172_801);
    let ix = env.slash_bond_ix();
    env.send_ok(&[ix], &[&op]);
    let state = env.state();
    assert!(state.paused);
    assert_eq!(env.balance(&env.pda.bond), 0);
    assert_eq!(env.balance(&env.pda.idle), usdc(7_000));
}

#[test]
fn nav_needs_a_quorum_of_distinct_attestors() {
    let mut env = Env::new();
    let op = env.operator.insecure_clone();
    let outsider = Keypair::new();
    let [a, b, _] = [&env.attestors[0], &env.attestors[1], &env.attestors[2]].map(|k| k.insecure_clone());
    let quorum = err(VaultError::QuorumNotMet);

    let ixs = env.nav_ixs(env.report(1), &[&a]);
    env.send_err(&ixs, &[&op], quorum);
    let ixs = env.nav_ixs(env.report(1), &[&a, &outsider]);
    env.send_err(&ixs, &[&op], quorum);
    let ixs = env.nav_ixs(env.report(1), &[&a, &a]);
    env.send_err(&ixs, &[&op], quorum);

    // Signatures over a different equity do not count for the submitted report.
    let mut ixs = env.nav_ixs(env.report(999), &[&a, &b]);
    *ixs.last_mut().unwrap() = env.submit_nav_ix(&op.pubkey(), env.report(1));
    env.send_err(&ixs, &[&op], quorum);

    let ixs = env.nav_ixs(env.report(5), &[&a, &b]);
    env.send_ok(&ixs, &[&op]);
    assert_eq!(env.state().gemini_equity, 5);

    let ixs = env.nav_ixs(env.report(2), &[&a, &b]);
    env.send_err(&ixs, &[&op], err(VaultError::NavReplay));

    let mut future = env.report(6);
    future.timestamp += 120;
    let ixs = env.nav_ixs(future, &[&a, &b]);
    env.send_err(&ixs, &[&op], err(VaultError::NavFromFuture));

    env.warp(10);
    let ixs = env.nav_ixs(env.report(6), &[&a, &b]);
    env.send_ok(&ixs, &[&op]);
    assert_eq!(env.state().gemini_equity, 6);
}

#[test]
fn draw_gate_conditions() {
    let mut env = Env::new();
    let op = env.operator.insecure_clone();
    let (staker, _) = env.onboard(usdc(10_000));
    env.post_nav(0);

    let ix = env.draw_ix(usdc(1_000));
    env.send_err(&[ix], &[&op], err(VaultError::GateBondCoverage));
    env.post_bond(usdc(2_000));

    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = env.draw_ix_to(&stranger.pubkey(), &env.gemini_usdc.clone(), usdc(1_000));
    env.send_err(&[ix], &[&stranger], err(VaultError::Unauthorized));

    let operator_usdc = env.operator_usdc;
    let ix = env.draw_ix_to(&op.pubkey(), &operator_usdc, usdc(1_000));
    env.send_err(&[ix], &[&op], CONSTRAINT_ADDRESS);

    let ix = env.draw_ix(usdc(25_001));
    env.send_err(&[ix], &[&op], err(VaultError::GatePerDrawLimit));

    let sentinel = env.sentinel.insecure_clone();
    let ix = env.sentinel_ix(&op.pubkey(), ix::Pause {}.data());
    env.send_err(&[ix], &[&op], err(VaultError::Unauthorized));
    let ix = env.sentinel_ix(&sentinel.pubkey(), ix::Pause {}.data());
    env.send_ok(&[ix], &[&sentinel]);
    let ix = env.draw_ix(usdc(1_000));
    env.send_err(&[ix], &[&op], err(VaultError::Paused));
    let ix = env.sentinel_ix(&sentinel.pubkey(), ix::Unpause {}.data());
    env.send_ok(&[ix], &[&sentinel]);

    // Half the shares queued for withdrawal: idle must keep 5,000 back.
    let ix = env.request_withdraw_ix(&staker.pubkey(), usdc(5_000));
    env.send_ok(&[ix], &[&staker]);
    let ix = env.draw_ix(usdc(5_500));
    env.send_err(&[ix], &[&op], err(VaultError::GateIdleBuffer));
    env.draw(usdc(4_000)).unwrap();

    // 4,000 drawn needs 600 of bond.
    let ix = env.release_bond_ix(usdc(1_500));
    env.send_err(&[ix], &[&op], err(VaultError::BondLocked));
    let ix = env.release_bond_ix(usdc(1_300));
    env.send_ok(&[ix], &[&op]);

    env.warp(3_600);
    let ix = env.draw_ix(usdc(1));
    env.send_err(&[ix], &[&op], err(VaultError::GateNavStale));

    // Equity at 95% of principal: above the breaker, below the 97% health gate.
    env.post_nav(usdc(3_800));
    assert!(!env.state().recall.active);
    let ix = env.draw_ix(usdc(1));
    env.send_err(&[ix], &[&op], err(VaultError::GateHealth));
}

#[test]
fn silent_attestors_open_a_recall() {
    let mut env = Env::new();
    env.post_bond(usdc(2_000));
    env.onboard(usdc(10_000));
    env.post_nav(0);
    env.draw(usdc(5_000)).unwrap();

    let op = env.operator.insecure_clone();
    let ix = env.check_nav_silence_ix();
    env.send_err(&[ix], &[&op], err(VaultError::ConditionNotMet));

    env.warp(86_401);
    let ix = env.check_nav_silence_ix();
    env.send_ok(&[ix], &[&op]);
    let state = env.state();
    assert!(state.recall.active);
    assert_eq!(state.recall.reason, recall_reason::NAV_SILENCE);
    assert_eq!(state.recall.amount, usdc(5_000));
}

#[test]
fn deposits_wait_for_the_epoch_price() {
    let mut env = Env::new();
    let (staker, staker_usdc) = env.staker(usdc(1_000));
    let epoch = env.state().epoch;
    let ix = env.deposit_ix(&staker.pubkey(), &staker_usdc, usdc(1_000));
    env.send_ok(&[ix], &[&staker]);

    let ix = env.claim_deposit_ix(&staker.pubkey(), epoch);
    // The epoch record does not exist until settlement.
    assert!(env.send(&[ix], &[&staker]).is_err());

    let ix = env.settle_ix(&staker.pubkey());
    env.send_err(&[ix], &[&staker], err(VaultError::EpochTooSoon));
    env.warp(3_601);
    env.settle();
    let ix = env.claim_deposit_ix(&staker.pubkey(), epoch);
    env.send_ok(&[ix], &[&staker]);
    assert_eq!(env.shares_of(&staker.pubkey()), usdc(1_000));
}
