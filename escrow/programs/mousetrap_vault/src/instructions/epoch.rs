use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    error::VaultError,
    math::{add, assets_for, bps_of, mul_div, price, shares_for},
    state::*,
    token_ops,
};

#[derive(Accounts)]
pub struct SettleEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(address = config.idle_vault)]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        space = 8 + EpochRecord::INIT_SPACE,
        seeds = [EPOCH_SEED, &state.epoch.to_le_bytes()],
        bump
    )]
    pub epoch_record: Box<Account<'info, EpochRecord>>,
    pub system_program: Program<'info, System>,
}

/// The daily crank: takes the performance fee, fixes this epoch's share price,
/// converts queued deposits and withdrawals at it, and raises a recall if idle USDC
/// cannot cover settled withdrawals plus the buffer.
pub fn handle_settle_epoch(ctx: Context<SettleEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let params = ctx.accounts.config.settings.params;
    let idle = ctx.accounts.idle_vault.amount;
    let state = &mut ctx.accounts.state;

    require!(now - state.last_settle_at >= params.epoch_min_secs, VaultError::EpochTooSoon);
    if state.drawn_principal > 0 || state.gemini_equity > 0 {
        require!(
            state.nav_at > state.last_settle_at && now - state.nav_at < params.nav_max_age_secs,
            VaultError::NavRequired
        );
    }

    let assets = state.net_assets(idle);
    let mut shares = state.total_shares;
    let mut fee_shares = 0;
    if shares > 0 {
        let current = price(assets, shares);
        if current > state.high_water_price {
            if params.performance_fee_bps > 0 {
                let gain = (current - state.high_water_price) * shares as u128 / PRICE_SCALE;
                let fee = bps_of(gain as u64, params.performance_fee_bps);
                if fee > 0 && fee < assets {
                    fee_shares = mul_div(fee, add(shares, VIRTUAL_UNITS)?, add(assets, VIRTUAL_UNITS)? - fee)?;
                    shares = add(shares, fee_shares)?;
                    state.fee_shares_owed = add(state.fee_shares_owed, fee_shares)?;
                }
            }
            state.high_water_price = price(assets, shares);
        }
    }

    let record = &mut ctx.accounts.epoch_record;
    record.epoch = state.epoch;
    record.assets = assets;
    record.shares = shares;
    record.settled_at = now;
    record.bump = ctx.bumps.epoch_record;

    let minted = shares_for(state.pending_deposits, assets, shares)?;
    let owed = assets_for(state.pending_withdraw_shares, assets, shares)?;
    state.total_shares = add(shares, minted)?
        .checked_sub(state.pending_withdraw_shares)
        .ok_or(error!(VaultError::MathOverflow))?;
    state.reserved_withdrawals = add(state.reserved_withdrawals, owed)?;
    state.pending_deposits = 0;
    state.pending_withdraw_shares = 0;
    state.last_settle_at = now;
    emit!(EpochSettled { epoch: record.epoch, assets, shares, fee_shares });
    state.epoch += 1;

    let needed = add(state.reserved_withdrawals, bps_of(state.net_assets(idle), params.buffer_bps))?;
    if needed > idle && state.drawn_principal > 0 {
        let shortfall = (needed - idle).min(state.drawn_principal);
        state.open_recall(shortfall, recall_reason::WITHDRAWALS, now, params.recall_deadline_secs);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
    #[account(mut, address = config.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    /// CHECK: only used as the owner of the fee share account
    #[account(address = config.settings.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = share_mint,
        associated_token::authority = fee_recipient
    )]
    pub fee_shares: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let owed = ctx.accounts.state.fee_shares_owed;
    require!(owed > 0, VaultError::NoFees);
    token_ops::mint_shares(
        &ctx.accounts.token_program.to_account_info(),
        ctx.accounts.share_mint.to_account_info(),
        ctx.accounts.fee_shares.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.config.authority_bump,
        owed,
    )?;
    ctx.accounts.state.fee_shares_owed = 0;
    Ok(())
}
