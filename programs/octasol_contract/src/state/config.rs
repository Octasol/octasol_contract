// In state/config.rs or your main state file

use anchor_lang::prelude::*;

#[account]
pub struct ConfigState {
    // The public key of the oracle/admin authorized to call protected instructions.
    pub admin: Pubkey,
    // The bump seed for this PDA.
    pub bump: u8,
}

impl ConfigState {
    // 8 bytes for discriminator + 32 for the pubkey + 1 for the bump
    pub const LEN: usize = 8 + 32 + 1;
}