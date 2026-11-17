use anchor_lang::{
    compat::solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked},
    prelude::*,
};

use crate::{
    constants::*,
    error::VaultError,
    state::NavReport,
};

/// The bytes each attestor signs: domain, vault state address, then the report fields.
pub fn nav_message(state: &Pubkey, report: &NavReport) -> Vec<u8> {
    let mut msg = Vec::with_capacity(NAV_DOMAIN.len() + 32 + 8 + 32 + 8 + 8);
    msg.extend_from_slice(NAV_DOMAIN);
    msg.extend_from_slice(state.as_ref());
    msg.extend_from_slice(&report.equity.to_le_bytes());
    msg.extend_from_slice(&report.positions_hash);
    msg.extend_from_slice(&report.rebate_total.to_le_bytes());
    msg.extend_from_slice(&report.timestamp.to_le_bytes());
    msg
}

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const SAME_IX: u16 = u16::MAX;

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(error!(VaultError::MalformedSignature))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = offset as usize;
    data.get(start..start + len)
        .ok_or(error!(VaultError::MalformedSignature))
}

/// Counts distinct attestors whose signature over `message` was verified by an
/// ed25519 precompile instruction earlier in this transaction. The runtime rejects
/// the whole transaction if any precompile signature is invalid, so a matching
/// pubkey and message here means a valid signature.
pub fn count_attestor_signatures(
    instructions: &AccountInfo,
    message: &[u8],
    attestors: &[Pubkey],
) -> Result<u8> {
    let current = load_current_index_checked(instructions)? as usize;
    let mut seen = [false; MAX_ATTESTORS];

    for index in 0..current {
        let ix = load_instruction_at_checked(index, instructions)?;
        if ix.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        let data = &ix.data;
        let count = *data.first().ok_or(error!(VaultError::MalformedSignature))? as usize;
        for i in 0..count {
            let base = OFFSETS_START + i * OFFSETS_LEN;
            let sig_ix = read_u16(data, base + 2)?;
            let pk_offset = read_u16(data, base + 4)?;
            let pk_ix = read_u16(data, base + 6)?;
            let msg_offset = read_u16(data, base + 8)?;
            let msg_len = read_u16(data, base + 10)?;
            let msg_ix = read_u16(data, base + 12)?;
            // Signature, key and message must all live in this precompile instruction.
            if sig_ix != SAME_IX || pk_ix != SAME_IX || msg_ix != SAME_IX {
                continue;
            }
            if slice(data, msg_offset, msg_len as usize)? != message {
                continue;
            }
            let key = Pubkey::try_from(slice(data, pk_offset, 32)?)
                .map_err(|_| error!(VaultError::MalformedSignature))?;
            if let Some(pos) = attestors.iter().position(|a| *a == key) {
                seen[pos] = true;
            }
        }
    }
    Ok(seen.iter().filter(|s| **s).count() as u8)
}
