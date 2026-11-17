use anchor_lang::{compat::solana_instructions_sysvar, prelude::*};
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    attest::{count_attestor_signatures, nav_message},
    constants::*,
    error::VaultError,
    math::ratio_at_least,
    state::*,
    token_ops,
};

#[derive(Accounts)]
pub struct SubmitNav<'info> {
    pub submitter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar, read for the ed25519 precompile instructions
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Records a NAV report signed by an attestor quorum (ed25519 precompile instructions
/// earlier in the same transaction), then runs the equity circuit breaker.
pub fn handle_submit_nav(ctx: Context<SubmitNav>, report: NavReport) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let settings = &ctx.accounts.config.settings;
    let params = settings.params;
    let state = &ctx.accounts.state;

    require!(report.timestamp > state.nav_at, VaultError::NavReplay);
    require!(report.timestamp <= now + NAV_CLOCK_SKEW_SECS, VaultError::NavFromFuture);
    require!(now - report.timestamp < params.nav_max_age_secs, VaultError::NavTooOld);

    let message = nav_message(&state.key(), &report);
    let signers = count_attestor_signatures(
        &ctx.accounts.instructions.to_account_info(),
        &message,
        settings.active_attestors(),
    )?;
    require!(signers >= settings.quorum, VaultError::QuorumNotMet);

    let state = &mut ctx.accounts.state;
    state.gemini_equity = report.equity;
    state.nav_at = report.timestamp;
    state.positions_hash = report.positions_hash;
    state.rebate_total = report.rebate_total;
    emit!(NavSubmitted {
        equity: report.equity,
        timestamp: report.timestamp,
        signers,
        positions_hash: report.positions_hash,
        rebate_total: report.rebate_total,
    });

    let drawn = state.drawn_principal;
    if drawn > 0 && !ratio_at_least(report.equity, drawn, params.recall_health_bps) {
        // The bond covers the shortfall first; what it covers is no longer owed.
        let slash = (drawn - report.equity).min(ctx.accounts.bond_vault.amount);
        if slash > 0 {
            token_ops::transfer_signed(
                &ctx.accounts.token_program.to_account_info(),
                ctx.accounts.bond_vault.to_account_info(),
                ctx.accounts.idle_vault.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.config.authority_bump,
                slash,
            )?;
            let state = &mut ctx.accounts.state;
            state.drawn_principal -= slash;
            emit!(BondSlashed { amount: slash, reason: recall_reason::BREAKER });
        }
        let state = &mut ctx.accounts.state;
        let outstanding = state.drawn_principal;
        state.open_recall(outstanding, recall_reason::BREAKER, now, params.recall_deadline_secs);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CheckNavSilence<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
}

/// Anyone can open a full recall once attestors have been silent too long.
pub fn handle_check_nav_silence(ctx: Context<CheckNavSilence>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let params = ctx.accounts.config.settings.params;
    let state = &mut ctx.accounts.state;
    require!(state.drawn_principal > 0, VaultError::NothingDrawn);
    require!(now - state.nav_at > params.nav_silence_secs, VaultError::ConditionNotMet);
    let amount = state.drawn_principal;
    state.open_recall(amount, recall_reason::NAV_SILENCE, now, params.recall_deadline_secs);
    Ok(())
}

#[derive(Accounts)]
pub struct SlashBond<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Anyone can call this after a missed recall deadline: draws pause, the whole bond
/// moves into the vault as a penalty.
pub fn handle_slash_bond(ctx: Context<SlashBond>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    require!(
        state.recall.active && now > state.recall.deadline && state.drawn_principal > 0,
        VaultError::ConditionNotMet
    );
    let bond = ctx.accounts.bond_vault.amount;
    if bond > 0 {
        token_ops::transfer_signed(
            &ctx.accounts.token_program.to_account_info(),
            ctx.accounts.bond_vault.to_account_info(),
            ctx.accounts.idle_vault.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.config.authority_bump,
            bond,
        )?;
        emit!(BondSlashed { amount: bond, reason: ctx.accounts.state.recall.reason });
    }
    let state = &mut ctx.accounts.state;
    state.paused = true;
    Ok(())
}
