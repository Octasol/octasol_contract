use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::{Token, TokenAccount}};

use crate::state::{Bounty, ConfigState};

#[derive(Accounts)]
pub struct CancelBounty<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    
    #[account(
        seeds = [b"config"],
        bump,
        constraint = config.admin == admin.key() @ crate::util::errors::ContractError::Unauthorized
    )]
    pub config: Account<'info, ConfigState>,
    
    #[account(
        mut,
        close = maintainer, 
        constraint = bounty.state != crate::state::BountyState::Completed @ crate::util::errors::ContractError::BountyAlreadyCompleted,
        constraint = bounty.state != crate::state::BountyState::Cancelled @ crate::util::errors::ContractError::BountyAlreadyCancelled
    )]
    pub bounty: Account<'info, Bounty>,
    
    #[account(
        mut,
        seeds = [b"escrow_auth", bounty.key().as_ref()],
        bump = bounty.bump
    )]
    /// CHECK: Account for transferring funds from escrow to maintainer
    pub escrow_authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    /// CHECK: The maintainer who will receive tokens and rent (doesn't need to sign)
    pub maintainer: UncheckedAccount<'info>,
    
    #[account(
        mut,
        constraint = maintainer_token_account.mint == bounty.mint @ crate::util::errors::ContractError::InvalidMint,
        constraint = maintainer_token_account.owner == maintainer.key() @ crate::util::errors::ContractError::InvalidTokenAccount
    )]
    pub maintainer_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        close = maintainer, // Rent goes to maintainer
        constraint = escrow_token_account.mint == bounty.mint @ crate::util::errors::ContractError::InvalidMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>
}
