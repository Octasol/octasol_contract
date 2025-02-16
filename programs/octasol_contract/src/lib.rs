use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("tMf5EmV2h6sMJ2QMFU6766ACJpf7NTuamPzCudaNFus");

#[program]
pub mod octasol_contract {
    use super::*;

    pub fn initialize_bounty(
        ctx: Context<InitializeBounty>,
        bounty_id: u64,
        amount: u64,
        github_issue_id: u64,
        maintainer_github_id: u64,
    ) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        bounty.maintainer = ctx.accounts.maintainer.key();
        bounty.amount = amount;
        bounty.github_issue_id = github_issue_id;
        bounty.maintainer_github_id = maintainer_github_id;
        bounty.state = BountyState::Created;
        bounty.bounty_id = bounty_id;

        // Transfer tokens from maintainer to escrow account
        let transfer_instruction = Transfer {
            from: ctx.accounts.maintainer_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.maintainer.to_account_info(),
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                transfer_instruction,
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn assign_contributor(
        ctx: Context<AssignContributor>,
        contributor_github_id: u64,
    ) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(
            bounty.state == BountyState::Created,
            BountyError::InvalidBountyState
        );

        bounty.contributor = Some(ctx.accounts.contributor.key());
        bounty.contributor_github_id = Some(contributor_github_id);
        bounty.state = BountyState::InProgress;

        Ok(())
    }

    pub fn complete_bounty(ctx: Context<CompleteBounty>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(
            bounty.state == BountyState::InProgress,
            BountyError::InvalidBountyState
        );

        // Transfer tokens from escrow to contributor
        let transfer_instruction = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.contributor_token_account.to_account_info(),
            authority: bounty.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_instruction,
                &[&[
                    b"bounty".as_ref(),
                    bounty.bounty_id.to_le_bytes().as_ref(),
                    &[ctx.bumps.bounty],
                ]],
            ),
            bounty.amount,
        )?;

        bounty.state = BountyState::Completed;

        Ok(())
    }

    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(
            bounty.state == BountyState::Created || bounty.state == BountyState::InProgress,
            BountyError::InvalidBountyState
        );

        // Transfer tokens back to maintainer
        let transfer_instruction = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.maintainer_token_account.to_account_info(),
            authority: bounty.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_instruction,
                &[&[
                    b"bounty".as_ref(),
                    bounty.bounty_id.to_le_bytes().as_ref(),
                    &[ctx.bumps.bounty],
                ]],
            ),
            bounty.amount,
        )?;

        bounty.state = BountyState::Cancelled;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bounty_id: u64)]
pub struct InitializeBounty<'info> {
    #[account(
        init,
        payer = maintainer,
        space = Bounty::LEN,
        seeds = [b"bounty".as_ref(), bounty_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(mut)]
    pub maintainer: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = maintainer,
    )]
    pub maintainer_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = maintainer,
        associated_token::mint = mint,
        associated_token::authority = bounty,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AssignContributor<'info> {
    #[account(
        mut,
        has_one = maintainer,
        seeds = [b"bounty".as_ref(), bounty.bounty_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(mut)]
    pub maintainer: Signer<'info>,

    /// CHECK: Contributor address is validated in the instruction
    pub contributor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CompleteBounty<'info> {
    #[account(
        mut,
        has_one = maintainer,
        constraint = bounty.contributor.unwrap() == contributor.key(),
        seeds = [b"bounty".as_ref(), bounty.bounty_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(mut)]
    pub maintainer: Signer<'info>,

    /// CHECK: Contributor is validated in the account constraint
    pub contributor: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bounty,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = contributor,
    )]
    pub contributor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelBounty<'info> {
    #[account(
        mut,
        has_one = maintainer,
        seeds = [b"bounty".as_ref(), bounty.bounty_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(mut)]
    pub maintainer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bounty,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = maintainer,
    )]
    pub maintainer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Bounty {
    pub maintainer: Pubkey,
    pub contributor: Option<Pubkey>,
    pub amount: u64,
    pub state: BountyState,
    pub bounty_id: u64,
    pub github_issue_id: u64,
    pub maintainer_github_id: u64,
    pub contributor_github_id: Option<u64>,
}

impl Bounty {
    pub const LEN: usize = 8 + // discriminator
        32 + // maintainer pubkey
        33 + // contributor option pubkey
        8 + // amount
        1 + // state
        8 + // bounty_id
        8 + // github_issue_id
        8 + // maintainer_github_id
        9; // contributor_github_id option
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum BountyState {
    Created,
    InProgress,
    Completed,
    Cancelled,
}

#[error_code]
pub enum BountyError {
    #[msg("Invalid bounty state for this operation")]
    InvalidBountyState,
}
