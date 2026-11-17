use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct VaultParams {
    /// Gate 1: bond must cover this share of outstanding principal.
    pub bond_min_bps: u16,
    /// Gate 2: hard cap on outstanding principal, in USDC base units.
    pub absolute_cap: u64,
    /// Gate 3: outstanding principal as a share of NAV.
    pub drawn_nav_max_bps: u16,
    /// Gate 4: idle USDC kept back as a share of NAV.
    pub buffer_bps: u16,
    /// Gate 6: attested equity over outstanding principal needed to draw.
    pub health_min_bps: u16,
    /// Below this, a NAV report slashes the bond and opens a full recall.
    pub recall_health_bps: u16,
    /// Gate 8: largest single draw as a share of `absolute_cap`.
    pub per_draw_bps: u16,
    /// Gate 5: oldest NAV report a draw or settlement accepts.
    pub nav_max_age_secs: i64,
    /// With principal drawn and no report for this long, anyone can open a recall.
    pub nav_silence_secs: i64,
    pub recall_deadline_secs: i64,
    pub epoch_min_secs: i64,
    /// Taken above the share price high-water mark at each settlement.
    pub performance_fee_bps: u16,
    /// Cap on NAV plus pending deposits. Zero means no cap.
    pub deposit_cap: u64,
}

impl VaultParams {
    pub fn validate(&self) -> Result<()> {
        let bps = [
            self.bond_min_bps,
            self.drawn_nav_max_bps,
            self.buffer_bps,
            self.health_min_bps,
            self.recall_health_bps,
            self.per_draw_bps,
            self.performance_fee_bps,
        ];
        require!(bps.iter().all(|b| *b as u64 <= BPS), VaultError::InvalidParams);
        require!(self.recall_health_bps <= self.health_min_bps, VaultError::InvalidParams);
        require!(
            self.nav_max_age_secs > 0
                && self.nav_silence_secs >= self.nav_max_age_secs
                && self.recall_deadline_secs > 0
                && self.epoch_min_secs >= 0,
            VaultError::InvalidParams
        );
        Ok(())
    }
}

/// Roles, destination and limits. Fixed at initialisation; no instruction changes them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, PartialEq, Eq)]
pub struct VaultSettings {
    pub params: VaultParams,
    pub sentinel: Pubkey,
    pub operator: Pubkey,
    pub fee_recipient: Pubkey,
    /// USDC token account of the operator's Gemini deposit address.
    pub gemini_destination: Pubkey,
    pub attestors: [Pubkey; 5],
    pub attestor_count: u8,
    pub quorum: u8,
}

impl VaultSettings {
    pub fn validate(&self) -> Result<()> {
        self.params.validate()?;
        let n = self.attestor_count as usize;
        require!(
            n > 0 && n <= MAX_ATTESTORS && self.quorum > 0 && self.quorum <= self.attestor_count,
            VaultError::InvalidAttestors
        );
        let set = &self.attestors[..n];
        for (i, a) in set.iter().enumerate() {
            require!(*a != Pubkey::default(), VaultError::InvalidAttestors);
            require!(!set[..i].contains(a), VaultError::InvalidAttestors);
        }
        require!(self.gemini_destination != Pubkey::default(), VaultError::InvalidParams);
        Ok(())
    }

    pub fn active_attestors(&self) -> &[Pubkey] {
        &self.attestors[..self.attestor_count as usize]
    }
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub owner: Pubkey,
    pub usdc_mint: Pubkey,
    pub share_mint: Pubkey,
    pub idle_vault: Pubkey,
    pub bond_vault: Pubkey,
    pub settings: VaultSettings,
    pub bump: u8,
    pub authority_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Debug, Default, PartialEq, Eq)]
pub struct Recall {
    pub active: bool,
    pub amount: u64,
    pub repaid: u64,
    pub opened_at: i64,
    pub deadline: i64,
    pub reason: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    /// Shares outstanding, including settled deposits not yet claimed and fee shares owed.
    pub total_shares: u64,
    pub drawn_principal: u64,
    /// Last attested equity, adjusted for draws and repayments since.
    pub gemini_equity: u64,
    /// Signed timestamp of the last accepted NAV report.
    pub nav_at: i64,
    pub positions_hash: [u8; 32],
    pub rebate_total: u64,
    pub epoch: u64,
    pub last_settle_at: i64,
    /// USDC deposited this epoch, waiting for the epoch price.
    pub pending_deposits: u64,
    /// Shares burned for withdrawal this epoch, still counted in `total_shares`.
    pub pending_withdraw_shares: u64,
    /// USDC owed to settled withdrawal tickets.
    pub reserved_withdrawals: u64,
    pub fee_shares_owed: u64,
    pub high_water_price: u128,
    pub paused: bool,
    pub recall: Recall,
    pub bump: u8,
}

impl VaultState {
    /// NAV attributable to shareholders: idle USDC plus attested Gemini equity,
    /// less USDC that belongs to pending deposits or settled withdrawals.
    pub fn net_assets(&self, idle_balance: u64) -> u64 {
        let owed = self.pending_deposits.saturating_add(self.reserved_withdrawals);
        (idle_balance as u128 + self.gemini_equity as u128)
            .saturating_sub(owed as u128)
            .min(u64::MAX as u128) as u64
    }

    /// Idle USDC that no deposit ticket or settled withdrawal has a claim on.
    pub fn free_idle(&self, idle_balance: u64) -> u64 {
        idle_balance
            .saturating_sub(self.pending_deposits)
            .saturating_sub(self.reserved_withdrawals)
    }

    /// Opens a recall, or grows the open one without moving its deadline.
    pub fn open_recall(&mut self, amount: u64, reason: u8, now: i64, deadline_secs: i64) {
        if amount == 0 {
            return;
        }
        if self.recall.active {
            self.recall.amount = self.recall.amount.max(self.recall.repaid.saturating_add(amount));
            return;
        }
        self.recall = Recall {
            active: true,
            amount,
            repaid: 0,
            opened_at: now,
            deadline: now.saturating_add(deadline_secs),
            reason,
        };
        emit!(RecallOpened { amount, reason, deadline: self.recall.deadline });
    }
}

#[account]
#[derive(InitSpace)]
pub struct EpochRecord {
    pub epoch: u64,
    /// NAV and shares at settlement, after fees: the price every ticket of this epoch uses.
    pub assets: u64,
    pub shares: u64,
    pub settled_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DepositTicket {
    pub owner: Pubkey,
    pub epoch: u64,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawTicket {
    pub owner: Pubkey,
    pub epoch: u64,
    pub shares: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavReport {
    pub equity: u64,
    pub positions_hash: [u8; 32],
    pub rebate_total: u64,
    pub timestamp: i64,
}

#[event]
pub struct RecallOpened {
    pub amount: u64,
    pub reason: u8,
    pub deadline: i64,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub epoch: u64,
    pub amount: u64,
}

#[event]
pub struct WithdrawRequested {
    pub owner: Pubkey,
    pub epoch: u64,
    pub shares: u64,
}

#[event]
pub struct Drawn {
    pub amount: u64,
    pub categories: u32,
    pub outstanding: u64,
}

#[event]
pub struct Returned {
    pub amount: u64,
    pub principal: u64,
    pub outstanding: u64,
}

#[event]
pub struct NavSubmitted {
    pub equity: u64,
    pub timestamp: i64,
    pub signers: u8,
    pub positions_hash: [u8; 32],
    pub rebate_total: u64,
}

#[event]
pub struct EpochSettled {
    pub epoch: u64,
    pub assets: u64,
    pub shares: u64,
    pub fee_shares: u64,
}

#[event]
pub struct BondSlashed {
    pub amount: u64,
    pub reason: u8,
}