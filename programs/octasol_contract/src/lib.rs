use anchor_lang::prelude::*;
use anchor_spl::token::{transfer,Transfer};
use anchor_spl::token::{close_account, CloseAccount};


pub mod context;
pub mod state;
pub mod util;

use context::*;
use state::*;
use util::{errors::ContractError, events::*};


declare_id!("tMf5EmV2h6sMJ2QMFU6766ACJpf7NTuamPzCudaNFus");




#[program]
pub mod octasol_contract {


    use super::*;



    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key(); // Set the initial admin
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn initialize_bounty(
        ctx: Context<InitializeBounty>,
        bounty_id: u64,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ContractError::InvalidAmount);

        let bounty = &mut ctx.accounts.bounty;
        bounty.maintainer = ctx.accounts.maintainer.key();
        bounty.contributor = None;
        bounty.mint = ctx.accounts.mint.key();
        bounty.amount = amount;
        bounty.bump = ctx.bumps.escrow_authority;
        bounty.bounty_id = bounty_id;
        bounty.state = BountyState::Created;

        // Transfer tokens from maintainer to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.maintainer_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.maintainer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        let _ =transfer(cpi_ctx, amount)?;

        emit!(BountyCreated {
            bounty_id,
            maintainer: ctx.accounts.maintainer.key(),
            amount,
        });

        Ok(())
    }

pub fn assign_contributor(ctx: Context<AssignContributor>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;

    // Security checks
    require!(bounty.state == BountyState::Created, ContractError::InvalidBountyStateForOperation);
    require!(bounty.contributor.is_none(), ContractError::ContributorAlreadyAssigned);
    require!(bounty.maintainer == ctx.accounts.maintainer.key(), ContractError::MaintainerMismatch);

    let contributor_key = ctx.accounts.contributor.key();

    bounty.contributor = Some(contributor_key);
    bounty.state = BountyState::InProgress;

    emit!(ContributorAssigned {
        bounty_id: bounty.bounty_id,
        contributor: contributor_key,
    });

    Ok(())
}


    // Maintainer completes bounty and pays contributor
    pub fn complete_bounty(ctx: Context<CompleteBounty>,bounty_id:u64) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        
        // Security checks
        require!(bounty.bounty_id == bounty_id, ContractError::InvalidBountyState);
        require!(bounty.state == BountyState::InProgress, ContractError::InvalidBountyStateForOperation);
        require!(bounty.contributor.is_some(), ContractError::InvalidContributor);
        require!(bounty.contributor.unwrap() == ctx.accounts.contributor.key(), ContractError::InvalidContributor);
        require!(bounty.mint == ctx.accounts.contributor_token_account.mint, ContractError::InvalidMint);
        require!(bounty.mint == ctx.accounts.escrow_token_account.mint, ContractError::InvalidMint);
      
        let bounty_key = bounty.key();
        let bump = bounty.bump;
        let seeds = &[b"escrow_auth",bounty_key.as_ref(),&[bump]];
        let binding = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer{
            from:ctx.accounts.escrow_token_account.to_account_info(),
            to:ctx.accounts.contributor_token_account.to_account_info(),
            authority:ctx.accounts.escrow_authority.to_account_info(),
        }, binding);

        let _ = transfer(cpi_ctx, bounty.amount)?;

        // Now, close the escrow token account using a CPI to the token program
        // The rent will be sent to the maintainer as specified in the context
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.maintainer.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            binding
        );

        close_account(cpi_ctx)?;

        emit!(BountyCompleted {
            bounty_id,
            contributor: ctx.accounts.contributor.key(),
            amount: bounty.amount,
        });
        
        bounty.state = BountyState::Completed;
        Ok(())
    }


    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        let bounty_key = bounty.key();
        let bump = bounty.bump;

        require!(bounty.state != BountyState::Completed, ContractError::BountyAlreadyCompleted);
        require!(bounty.state != BountyState::Cancelled, ContractError::BountyAlreadyCancelled);
        require!(bounty.maintainer == ctx.accounts.maintainer.key(), ContractError::MaintainerMismatch);
        require!(bounty.mint == ctx.accounts.maintainer_token_account.mint, ContractError::InvalidMint);
        require!(bounty.mint == ctx.accounts.escrow_token_account.mint, ContractError::InvalidMint);
    
    
        // Seeds for the PDA authority
        let seeds = &[
            b"escrow_auth",
            bounty_key.as_ref(),
            &[bump]
        ];
        let signer = &[&seeds[..]];
    
        // First, transfer the tokens from the escrow back to the maintainer
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.maintainer_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer
        );
    
        transfer(cpi_ctx, bounty.amount)?;
    
        // Now, close the escrow token account using a CPI to the token program
        // The rent will be sent to the maintainer as specified in the context
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.maintainer.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer
        );
    
        close_account(cpi_ctx)?;
    
        // The bounty account will be closed automatically by Anchor due to its 'close' constraint.
        // The rent from the bounty account will also go to the maintainer.
    
        emit!(BountyCancelled {
            bounty_id: bounty.bounty_id,
            maintainer: ctx.accounts.maintainer.key(),
            amount: bounty.amount,
        });
        
        bounty.state = BountyState::Cancelled;
        
        Ok(())
    }
    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        // Security checks
        require!(new_admin != Pubkey::default(), ContractError::InvalidBountyState);
        require!(new_admin != ctx.accounts.admin.key(), ContractError::InvalidBountyState);
        
        let config = &mut ctx.accounts.config;
        let old_admin = config.admin;
        config.admin = new_admin; // Update to the new admin key
        
        emit!(AdminUpdated {
            old_admin,
            new_admin,
        });
        
        Ok(())
    }

    pub fn admin_assign_and_release(ctx: Context<AdminAssignAndRelease>, bounty_id: u64) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;

        // Security checks
        require!(bounty.bounty_id == bounty_id, ContractError::InvalidBountyState);
        require!(bounty.mint == ctx.accounts.contributor_token_account.mint, ContractError::InvalidMint);
        require!(bounty.mint == ctx.accounts.escrow_token_account.mint, ContractError::InvalidMint);

        // Get the new contributor key
        let new_contributor_key = ctx.accounts.contributor.key();
        

        // Override with new contributor (admin super power)
        bounty.contributor = Some(new_contributor_key);
        bounty.state = BountyState::InProgress;
        
        // Emit event for contributor assignment
        emit!(ContributorAssigned { bounty_id: bounty.bounty_id, contributor: new_contributor_key });

        // Release funds from escrow to new contributor
        let bounty_key = bounty.key();
        let bump = bounty.bump;
        let seeds = &[b"escrow_auth", bounty_key.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.contributor_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer,
        );
        transfer(cpi_ctx, bounty.amount)?;

        // Now, close the escrow token account using a CPI to the token program
        // The rent will be sent to the maintainer as specified in the context
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.maintainer.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer
        );

        close_account(cpi_ctx)?;

        // Emit completion event
        emit!(BountyCompleted {
            bounty_id,
            contributor: new_contributor_key,
            amount: bounty.amount,
        });

        bounty.state = BountyState::Completed;
        Ok(())
    }
        



}