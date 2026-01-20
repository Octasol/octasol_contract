use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::{ Token, TokenAccount}};
use crate::state::{Bounty, ConfigState};

#[derive(Accounts)]
pub struct AdminAssignAndRelease<'info> {
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

    /// CHECK: Contributor to be assigned and paid
    #[account(mut)]
    pub contributor: UncheckedAccount<'info>,

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
