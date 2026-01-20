use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum BountyState {
    Created,
    InProgress,
    Completed,
    Cancelled,
}

#[account]
pub struct Bounty {
    pub maintainer: Pubkey,
    pub contributor: Option<Pubkey>,
    pub mint: Pubkey,
    pub bump: u8,
    pub amount: u64,
    pub state: BountyState,
    pub bounty_id: u64,
}

impl Bounty {
    pub const LEN: usize = 8 + // discriminator
        32 + // maintainer pubkey
        33 + // contributor option pubkey
        8 + // amount
        1 + // state
        8 + // bounty_id
        32 + // mint address
        8;  // bump
}

