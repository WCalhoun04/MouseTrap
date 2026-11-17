use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, MintTo, Transfer};

use crate::constants::AUTHORITY_SEED;

/// Moves USDC out of a vault-owned token account, signed by the authority PDA.
pub fn transfer_signed<'info>(
    token_program: &AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    authority_bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer { from, to, authority },
            &[seeds],
        ),
        amount,
    )
}

pub fn transfer_from_user<'info>(
    token_program: &AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(token_program.key(), Transfer { from, to, authority }),
        amount,
    )
}

pub fn mint_shares<'info>(
    token_program: &AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    authority_bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.key(),
            MintTo { mint, to, authority },
            &[seeds],
        ),
        amount,
    )
}

pub fn burn_shares<'info>(
    token_program: &AccountInfo<'info>,
    mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::burn(
        CpiContext::new(token_program.key(), Burn { mint, from, authority }),
        amount,
    )
}
