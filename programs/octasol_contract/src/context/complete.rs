use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::{ Token, TokenAccount}};
use crate::state::{Bounty, ConfigState};

#[derive(Accounts)]
pub struct CompleteBounty<'info> {
    #[account(
        mut,
        constraint = bounty.contributor.is_some() @ crate::util::errors::ContractError::InvalidContributor,
        constraint = bounty.state == crate::state::BountyState::InProgress @ crate::util::errors::ContractError::InvalidBountyStateForOperation,
        close = maintainer
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        seeds=[b"escrow_auth",bounty.key().as_ref()],
        bump = bounty.bump
    )]
    /// CHECK:PDA SIGNER
    pub escrow_authority: UncheckedAccount<'info>,

    /// CHECK: Maintainer account for rent collection
    #[account(mut)]
    pub maintainer: AccountInfo<'info>,

    /// CHECK: Contributor is validated by bounty.contributor field 
    #[account(
        mut,
        constraint = contributor.key() == bounty.contributor.unwrap() @ crate::util::errors::ContractError::InvalidContributor
    )]
    pub contributor: UncheckedAccount<'info>,

    #[account(
        seeds = [b"config"],
        bump,
        constraint = config.admin == admin.key() @ crate::util::errors::ContractError::Unauthorized
    )]
    pub config: Account<'info, ConfigState>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = contributor_token_account.mint == bounty.mint @ crate::util::errors::ContractError::InvalidMint,
        constraint = contributor_token_account.owner == contributor.key() @ crate::util::errors::ContractError::InvalidTokenAccount
    )]
    pub contributor_token_account:Account<'info,TokenAccount>,
    #[account(
        mut,
        constraint = escrow_token_account.mint == bounty.mint @ crate::util::errors::ContractError::InvalidMint
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info,System>,
    pub associated_token_program: Program<'info,AssociatedToken>
}
