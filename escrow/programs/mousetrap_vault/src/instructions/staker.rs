use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    error::VaultError,
    math::{add, assets_for, shares_for},
    state::*,
    token_ops,
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + DepositTicket::INIT_SPACE,
        seeds = [DEPOSIT_SEED, owner.key().as_ref(), &state.epoch.to_le_bytes()],
        bump
    )]
    pub ticket: Box<Account<'info, DepositTicket>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// USDC goes in now; shares are minted at this epoch's settlement price.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let state = &ctx.accounts.state;
    require!(!state.paused, VaultError::Paused);

    let cap = ctx.accounts.config.settings.params.deposit_cap;
    if cap > 0 {
        let nav = state.net_assets(ctx.accounts.idle_vault.amount);
        let after = add(add(nav, state.pending_deposits)?, amount)?;
        require!(after <= cap, VaultError::DepositCapExceeded);
    }

    token_ops::transfer_from_user(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.owner_usdc.to_account_info(),
        ctx.accounts.idle_vault.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        amount,
    )?;

    let epoch = ctx.accounts.state.epoch;
    let ticket = &mut ctx.accounts.ticket;
    ticket.owner = ctx.accounts.owner.key();
    ticket.epoch = epoch;
    ticket.amount = add(ticket.amount, amount)?;
    ticket.bump = ctx.bumps.ticket;

    let state = &mut ctx.accounts.state;
    state.pending_deposits = add(state.pending_deposits, amount)?;
    emit!(Deposited { owner: ticket.owner, epoch, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, has_one = owner, close = owner)]
    pub ticket: Box<Account<'info, DepositTicket>>,
    #[account(seeds = [EPOCH_SEED, &ticket.epoch.to_le_bytes()], bump = epoch_record.bump)]
    pub epoch_record: Box<Account<'info, EpochRecord>>,
    #[account(mut, address = config.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = share_mint,
        associated_token::authority = owner
    )]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    require!(ticket.epoch < ctx.accounts.state.epoch, VaultError::EpochNotSettled);
    let record = &ctx.accounts.epoch_record;
    let shares = shares_for(ticket.amount, record.assets, record.shares)?;
    if shares > 0 {
        token_ops::mint_shares(
            &ctx.accounts.token_program.to_account_info(),
            ctx.accounts.share_mint.to_account_info(),
            ctx.accounts.owner_shares.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.config.authority_bump,
            shares,
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + WithdrawTicket::INIT_SPACE,
        seeds = [WITHDRAW_SEED, owner.key().as_ref(), &state.epoch.to_le_bytes()],
        bump
    )]
    pub ticket: Box<Account<'info, WithdrawTicket>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Burns shares now; they are priced at this epoch's settlement. Works while paused.
pub fn handle_request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    token_ops::burn_shares(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.share_mint.to_account_info(),
        ctx.accounts.owner_shares.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        shares,
    )?;

    let epoch = ctx.accounts.state.epoch;
    let ticket = &mut ctx.accounts.ticket;
    ticket.owner = ctx.accounts.owner.key();
    ticket.epoch = epoch;
    ticket.shares = add(ticket.shares, shares)?;
    ticket.bump = ctx.bumps.ticket;

    let state = &mut ctx.accounts.state;
    state.pending_withdraw_shares = add(state.pending_withdraw_shares, shares)?;
    emit!(WithdrawRequested { owner: ticket.owner, epoch, shares });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, has_one = owner, close = owner)]
    pub ticket: Box<Account<'info, WithdrawTicket>>,
    #[account(seeds = [EPOCH_SEED, &ticket.epoch.to_le_bytes()], bump = epoch_record.bump)]
    pub epoch_record: Box<Account<'info, EpochRecord>>,
    #[account(mut, address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    require!(ticket.epoch < ctx.accounts.state.epoch, VaultError::EpochNotSettled);
    let record = &ctx.accounts.epoch_record;
    let payout = assets_for(ticket.shares, record.assets, record.shares)?;
    require!(payout <= ctx.accounts.idle_vault.amount, VaultError::InsufficientIdle);

    if payout > 0 {
        token_ops::transfer_signed(
            &ctx.accounts.token_program.to_account_info(),
            ctx.accounts.idle_vault.to_account_info(),
            ctx.accounts.owner_usdc.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.config.authority_bump,
            payout,
        )?;
    }
    let state = &mut ctx.accounts.state;
    state.reserved_withdrawals = state.reserved_withdrawals.saturating_sub(payout);
    Ok(())
}
