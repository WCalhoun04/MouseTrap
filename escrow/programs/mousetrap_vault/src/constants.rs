use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const STATE_SEED: &[u8] = b"state";
#[constant]
pub const AUTHORITY_SEED: &[u8] = b"authority";
#[constant]
pub const IDLE_SEED: &[u8] = b"idle";
#[constant]
pub const BOND_SEED: &[u8] = b"bond";
#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"shares";
#[constant]
pub const EPOCH_SEED: &[u8] = b"epoch";
#[constant]
pub const DEPOSIT_SEED: &[u8] = b"deposit";
#[constant]
pub const WITHDRAW_SEED: &[u8] = b"withdraw";

/// Prefix of the message attestors sign for a NAV report.
#[constant]
pub const NAV_DOMAIN: &[u8] = b"MOUSETRAP_NAV_V1";

pub const MAX_ATTESTORS: usize = 5;
pub const BPS: u64 = 10_000;
pub const USDC_DECIMALS: u8 = 6;
/// Virtual shares and assets (1 USDC) that make first-deposit and donation
/// share-price manipulation unprofitable.
pub const VIRTUAL_UNITS: u64 = 1_000_000;
pub const PRICE_SCALE: u128 = 1_000_000_000_000;
/// How far ahead of the cluster clock a signed NAV timestamp may be.
pub const NAV_CLOCK_SKEW_SECS: i64 = 60;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub mod recall_reason {
    pub const SENTINEL: u8 = 1;
    pub const WITHDRAWALS: u8 = 2;
    pub const BREAKER: u8 = 3;
    pub const NAV_SILENCE: u8 = 4;
}
