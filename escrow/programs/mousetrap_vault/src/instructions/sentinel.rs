use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError, state::*};

#[derive(Accounts)]
pub struct Sentinel<'info> {
    #[account(address = config.settings.sentinel @ VaultError::Unauthorized)]
    pub sentinel: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Box<Account<'info, VaultState>>,
}

pub fn handle_pause(ctx: Context<Sentinel>) -> Result<()> {
    ctx.accounts.state.paused = true;
    Ok(())
}

pub fn handle_unpause(ctx: Context<Sentinel>) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.paused = false;
    if state.recall.active && state.recall.reason == recall_reason::SENTINEL {
        state.recall = Recall::default();
    }
    Ok(())
}

pub fn handle_force_recall(ctx: Context<Sentinel>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let deadline = ctx.accounts.config.settings.params.recall_deadline_secs;
    let state = &mut ctx.accounts.state;
    require!(state.drawn_principal > 0, VaultError::NothingDrawn);
    let amount = state.drawn_principal;
    state.open_recall(amount, recall_reason::SENTINEL, now, deadline);
    Ok(())
}
