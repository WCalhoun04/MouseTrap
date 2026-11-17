pub mod attest;
pub mod constants;
pub mod error;
pub mod gate;
pub mod instructions;
pub mod math;
pub mod state;
pub mod token_ops;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("2rhxbbbqDtRPfGDAcd4LK7iqbR6Ro58R3QLs1NG9EZfd");

/// Maker-rebate vault escrow. See AGENTS.md sections 4 and 5.
#[program]
pub mod mousetrap_vault {
    use super::*;

    // --- setup and sentinel ---

    pub fn initialize(ctx: Context<Initialize>, settings: VaultSettings) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, settings)
    }

    pub fn pause(ctx: Context<Sentinel>) -> Result<()> {
        instructions::sentinel::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<Sentinel>) -> Result<()> {
        instructions::sentinel::handle_unpause(ctx)
    }

    pub fn force_recall(ctx: Context<Sentinel>) -> Result<()> {
        instructions::sentinel::handle_force_recall(ctx)
    }

    // --- stakers ---

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::staker::handle_deposit(ctx, amount)
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::staker::handle_claim_deposit(ctx)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        instructions::staker::handle_request_withdraw(ctx, shares)
    }

    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        instructions::staker::handle_claim_withdraw(ctx)
    }

    // --- operator and relayer ---

    pub fn post_bond(ctx: Context<PostBond>, amount: u64) -> Result<()> {
        instructions::operator::handle_post_bond(ctx, amount)
    }

    pub fn release_bond(ctx: Context<ReleaseBond>, amount: u64) -> Result<()> {
        instructions::operator::handle_release_bond(ctx, amount)
    }

    pub fn request_draw(ctx: Context<RequestDraw>, amount: u64, categories: u32) -> Result<()> {
        instructions::operator::handle_request_draw(ctx, amount, categories)
    }

    pub fn repay(ctx: Context<ReturnFunds>, amount: u64) -> Result<()> {
        instructions::operator::handle_repay(ctx, amount)
    }

    pub fn sweep_profit(ctx: Context<ReturnFunds>, amount: u64) -> Result<()> {
        instructions::operator::handle_sweep_profit(ctx, amount)
    }

    // --- attestors and cranks ---

    pub fn submit_nav(ctx: Context<SubmitNav>, report: NavReport) -> Result<()> {
        instructions::attestation::handle_submit_nav(ctx, report)
    }

    pub fn check_nav_silence(ctx: Context<CheckNavSilence>) -> Result<()> {
        instructions::attestation::handle_check_nav_silence(ctx)
    }

    pub fn slash_bond(ctx: Context<SlashBond>) -> Result<()> {
        instructions::attestation::handle_slash_bond(ctx)
    }

    pub fn settle_epoch(ctx: Context<SettleEpoch>) -> Result<()> {
        instructions::epoch::handle_settle_epoch(ctx)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::epoch::handle_claim_fees(ctx)
    }
}
