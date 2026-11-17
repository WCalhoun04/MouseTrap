use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError};

pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, VaultError::MathOverflow);
    let out = (a as u128) * (b as u128) / (c as u128);
    u64::try_from(out).map_err(|_| error!(VaultError::MathOverflow))
}

pub fn bps_of(amount: u64, bps: u16) -> u64 {
    ((amount as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// `a * BPS >= b * bps`, without rounding.
pub fn ratio_at_least(a: u64, b: u64, bps: u16) -> bool {
    (a as u128) * (BPS as u128) >= (b as u128) * (bps as u128)
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(error!(VaultError::MathOverflow))
}

/// Shares minted for `amount` USDC at a price of `assets / shares`.
pub fn shares_for(amount: u64, assets: u64, shares: u64) -> Result<u64> {
    mul_div(amount, add(shares, VIRTUAL_UNITS)?, add(assets, VIRTUAL_UNITS)?)
}

/// USDC paid for `amount` shares at a price of `assets / shares`.
pub fn assets_for(amount: u64, assets: u64, shares: u64) -> Result<u64> {
    mul_div(amount, add(assets, VIRTUAL_UNITS)?, add(shares, VIRTUAL_UNITS)?)
}

/// Share price scaled by `PRICE_SCALE`.
pub fn price(assets: u64, shares: u64) -> u128 {
    (assets as u128 + VIRTUAL_UNITS as u128) * PRICE_SCALE / (shares as u128 + VIRTUAL_UNITS as u128)
}
