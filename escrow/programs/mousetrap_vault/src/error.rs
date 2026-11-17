use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid vault parameters")]
    InvalidParams,
    #[msg("Invalid attestor set or quorum")]
    InvalidAttestors,
    #[msg("USDC mint must have 6 decimals")]
    InvalidMint,
    #[msg("Signer does not hold the required role")]
    Unauthorized,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Deposit would exceed the vault's TVL cap")]
    DepositCapExceeded,
    #[msg("Ticket belongs to an epoch that has not settled")]
    EpochNotSettled,
    #[msg("Idle USDC cannot cover this claim yet")]
    InsufficientIdle,

    #[msg("Gate 1: operator bond does not cover outstanding principal")]
    GateBondCoverage,
    #[msg("Gate 2: outstanding principal would exceed the absolute cap")]
    GateAbsoluteCap,
    #[msg("Gate 3: outstanding principal would exceed the allowed share of NAV")]
    GateNavShare,
    #[msg("Gate 4: idle buffer would fall below the minimum or queued withdrawals")]
    GateIdleBuffer,
    #[msg("Gate 5: no fresh quorum-signed NAV report")]
    GateNavStale,
    #[msg("Gate 6: attested Gemini equity is below the health threshold")]
    GateHealth,
    #[msg("Gate 8: a recall is open")]
    GateRecallOpen,
    #[msg("Gate 8: draw exceeds the per-draw limit")]
    GatePerDrawLimit,

    #[msg("Bond is locked behind outstanding draws or an open recall")]
    BondLocked,
    #[msg("NAV report timestamp is not newer than the last report")]
    NavReplay,
    #[msg("NAV report timestamp is in the future")]
    NavFromFuture,
    #[msg("NAV report is too old")]
    NavTooOld,
    #[msg("Not enough attestor signatures for quorum")]
    QuorumNotMet,
    #[msg("Malformed ed25519 instruction")]
    MalformedSignature,
    #[msg("Epoch cannot settle yet")]
    EpochTooSoon,
    #[msg("A fresh NAV report is required before settling")]
    NavRequired,
    #[msg("Breaker condition does not hold")]
    ConditionNotMet,
    #[msg("Nothing is drawn")]
    NothingDrawn,
    #[msg("No fees owed")]
    NoFees,
}
