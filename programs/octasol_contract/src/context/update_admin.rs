use anchor_lang::prelude::*;
use crate::state::ConfigState;

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    #[account(mut)]
    pub admin: Signer<'info>, // The current admin must sign

    #[account(
        mut,
        seeds = [b"config"],
        bump,
        has_one = admin, 
    )]
    pub config: Account<'info, ConfigState>,
}
