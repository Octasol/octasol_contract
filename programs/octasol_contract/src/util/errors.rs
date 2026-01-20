use anchor_lang::prelude::*;

#[error_code]
pub enum ContractError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient bounty amount")]
    InsufficientAmount,
    #[msg("Invalid bounty state")]
    InvalidBountyState,
    #[msg("Invalid contributor")]
    InvalidContributor,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Bounty is not in correct state for this operation")]
    InvalidBountyStateForOperation,
    #[msg("Maintainer mismatch")]
    MaintainerMismatch,
    #[msg("Contributor already assigned")]
    ContributorAlreadyAssigned,
    #[msg("Bounty is already completed")]
    BountyAlreadyCompleted,
    #[msg("Bounty is already cancelled")]
    BountyAlreadyCancelled,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
}


