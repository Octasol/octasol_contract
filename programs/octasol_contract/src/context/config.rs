use anchor_lang::prelude::*;
use crate::state::config::ConfigState;
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>, // The person deploying the contract becomes the first admin

    #[account(
        init,
        payer = admin,
        space = ConfigState::LEN,
        seeds = [b"config"], // Creates a predictable address for our config
        bump
    )]
    pub config: Account<'info, ConfigState>,
    pub system_program: Program<'info, System>,
}