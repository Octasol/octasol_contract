use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount, Token};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::Bounty;

#[derive(Accounts)]
pub struct InitializeBounty<'info> {
    #[account(mut)]
    pub maintainer: Signer<'info>,
    #[account(
        init,
        payer = maintainer,
        space = Bounty::LEN
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        mut,
        constraint = maintainer_token_account.owner == maintainer.key() @ crate::util::errors::ContractError::InvalidTokenAccount,
        constraint = maintainer_token_account.mint == mint.key() @ crate::util::errors::ContractError::InvalidMint
    )]
    pub maintainer_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [b"escrow_auth",bounty.key().as_ref()],
        bump
    )]
    /// CHECK: PDA SIGNER
    pub escrow_authority : UncheckedAccount<'info>,

    #[account(
        init,
        payer = maintainer,
        associated_token::mint = mint,
        associated_token::authority = escrow_authority,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
