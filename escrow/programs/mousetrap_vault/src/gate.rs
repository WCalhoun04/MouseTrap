use anchor_lang::prelude::*;

use crate::{
    constants::BPS,
    error::VaultError,
    math::{add, assets_for, bps_of, ratio_at_least},
    state::{VaultParams, VaultState},
};

/// The eight draw-gate conditions from AGENTS.md section 5. Condition 7 (destination)
/// is enforced by the account constraint on `request_draw`.
pub fn check_draw(
    params: &VaultParams,
    state: &VaultState,
    idle_balance: u64,
    bond_balance: u64,
    amount: u64,
    now: i64,
) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    require!(!state.paused, VaultError::Paused);
    require!(!state.recall.active, VaultError::GateRecallOpen);
    require!(
        amount <= bps_of(params.absolute_cap, params.per_draw_bps),
        VaultError::GatePerDrawLimit
    );

    let outstanding = add(state.drawn_principal, amount)?;
    require!(
        ratio_at_least(bond_balance, outstanding, params.bond_min_bps),
        VaultError::GateBondCoverage
    );
    require!(outstanding <= params.absolute_cap, VaultError::GateAbsoluteCap);

    let nav = state.net_assets(idle_balance);
    require!(
        (outstanding as u128) * (BPS as u128) <= (nav as u128) * (params.drawn_nav_max_bps as u128),
        VaultError::GateNavShare
    );

    let queued = assets_for(state.pending_withdraw_shares, nav, state.total_shares)?;
    let floor = bps_of(nav, params.buffer_bps).max(queued);
    let free_after = state
        .free_idle(idle_balance)
        .checked_sub(amount)
        .ok_or(error!(VaultError::GateIdleBuffer))?;
    require!(free_after >= floor, VaultError::GateIdleBuffer);

    require!(
        state.nav_at > 0 && now >= state.nav_at && now - state.nav_at < params.nav_max_age_secs,
        VaultError::GateNavStale
    );

    if state.drawn_principal > 0 {
        require!(
            ratio_at_least(state.gemini_equity, state.drawn_principal, params.health_min_bps),
            VaultError::GateHealth
        );
    }
    Ok(())
}
