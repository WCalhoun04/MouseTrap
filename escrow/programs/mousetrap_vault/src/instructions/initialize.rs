use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::VaultError, state::*};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [STATE_SEED],
        bump
    )]
    pub state: Box<Account<'info, VaultState>>,
    /// CHECK: PDA that owns the vault token accounts and the share mint; holds no data.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(constraint = usdc_mint.decimals == USDC_DECIMALS @ VaultError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = owner,
        seeds = [SHARE_MINT_SEED],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = authority
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = owner,
        seeds = [IDLE_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = authority
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        seeds = [BOND_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = authority
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(token::mint = usdc_mint)]
    pub gemini_destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, settings: VaultSettings) -> Result<()> {
    require_keys_eq!(
        settings.gemini_destination,
        ctx.accounts.gemini_destination.key(),
        VaultError::InvalidParams
    );
    settings.validate()?;
    let now = Clock::get()?.unix_timestamp;

    let config = &mut ctx.accounts.config;
    config.owner = ctx.accounts.owner.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.share_mint = ctx.accounts.share_mint.key();
    config.idle_vault = ctx.accounts.idle_vault.key();
    config.bond_vault = ctx.accounts.bond_vault.key();
    config.settings = settings;
    config.bump = ctx.bumps.config;
    config.authority_bump = ctx.bumps.authority;

    let state = &mut ctx.accounts.state;
    state.epoch = 1;
    state.last_settle_at = now;
    state.high_water_price = PRICE_SCALE;
    state.bump = ctx.bumps.state;
    Ok(())
}
