use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::VaultError,
    gate::check_draw,
    math::{add, ratio_at_least},
    state::*,
    token_ops,
};

#[derive(Accounts)]
pub struct PostBond<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, address = config.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    token_ops::transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.payer_usdc.to_account_info(),
        ctx.accounts.bond_vault.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        amount,
    )
}

#[derive(Accounts)]
pub struct ReleaseBond<'info> {
    #[account(address = config.settings.operator @ VaultError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = operator)]
    pub operator_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Only bond above what outstanding draws require can leave, and none during a recall.
pub fn handle_release_bond(ctx: Context<ReleaseBond>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let state = &ctx.accounts.state;
    require!(!state.recall.active, VaultError::BondLocked);
    let after = ctx
        .accounts
        .bond_vault
        .amount
        .checked_sub(amount)
        .ok_or(error!(VaultError::BondLocked))?;
    require!(
        ratio_at_least(after, state.drawn_principal, ctx.accounts.config.settings.params.bond_min_bps),
        VaultError::BondLocked
    );
    token_ops::transfer_signed(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.bond_vault.to_account_info(),
        ctx.accounts.operator_usdc.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.config.authority_bump,
        amount,
    )
}

#[derive(Accounts)]
pub struct RequestDraw<'info> {
    #[account(address = config.settings.operator @ VaultError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// Gate 7: the only account a draw can pay.
    #[account(mut, address = config.settings.gemini_destination)]
    pub gemini_destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// `categories` is a bitmask of declared market categories, recorded in the event.
pub fn handle_request_draw(ctx: Context<RequestDraw>, amount: u64, categories: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_draw(
        &ctx.accounts.config.settings.params,
        &ctx.accounts.state,
        ctx.accounts.idle_vault.amount,
        ctx.accounts.bond_vault.amount,
        amount,
        now,
    )?;
    token_ops::transfer_signed(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.idle_vault.to_account_info(),
        ctx.accounts.gemini_destination.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.config.authority_bump,
        amount,
    )?;
    let state = &mut ctx.accounts.state;
    state.drawn_principal = add(state.drawn_principal, amount)?;
    // In transit to Gemini: count it until the next NAV report confirms it.
    state.gemini_equity = add(state.gemini_equity, amount)?;
    emit!(Drawn { amount, categories, outstanding: state.drawn_principal });
    Ok(())
}

#[derive(Accounts)]
pub struct ReturnFunds<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = payer)]
    pub payer_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

fn pull_in(ctx: &Context<ReturnFunds>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    token_ops::transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.payer_usdc.to_account_info(),
        ctx.accounts.idle_vault.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        amount,
    )
}

/// Returns principal. Anyone can call it.
pub fn handle_repay(ctx: Context<ReturnFunds>, amount: u64) -> Result<()> {
    pull_in(&ctx, amount)?;
    let state = &mut ctx.accounts.state;
    let principal = amount.min(state.drawn_principal);
    state.drawn_principal -= principal;
    state.gemini_equity = state.gemini_equity.saturating_sub(amount);
    if state.recall.active {
        state.recall.repaid = state.recall.repaid.saturating_add(amount);
        if state.recall.repaid >= state.recall.amount || state.drawn_principal == 0 {
            state.recall = Recall::default();
        }
    }
    emit!(Returned { amount, principal, outstanding: state.drawn_principal });
    Ok(())
}

/// Returns profit without touching principal: the daily sweep.
pub fn handle_sweep_profit(ctx: Context<ReturnFunds>, amount: u64) -> Result<()> {
    pull_in(&ctx, amount)?;
    let state = &mut ctx.accounts.state;
    state.gemini_equity = state.gemini_equity.saturating_sub(amount);
    emit!(Returned { amount, principal: 0, outstanding: state.drawn_principal });
    Ok(())
}
