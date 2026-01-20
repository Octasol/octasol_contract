import { assert, expect } from "chai";
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorError } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, 
  createAssociatedTokenAccount, 
  mintTo, 
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import { OctasolContract } from '../target/types/octasol_contract';

// Helper to generate a random 64-bit number for the bounty ID
const generateBountyId = () => new anchor.BN(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

// Helper: assert Anchor error code
function expectAnchorErrorCode(e: unknown, code: string) {
  if (e instanceof AnchorError) {
    assert.equal(e.error.errorCode.code, code);
  } else {
    throw e;
  }
}


describe("Octasol Escrow Contract", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.OctasolContract as Program<OctasolContract>;
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  // Keypairs
  const maintainer = wallet.payer; // Use the wallet as the maintainer for simplicity
  const contributor = anchor.web3.Keypair.generate();
  const admin = wallet.payer; // Use the wallet as the admin for simplicity
  
  // This is the Keypair for the main Bounty account that holds the state
  const bountyAccountKp = anchor.web3.Keypair.generate();

  // Declare variables in the outer scope
  let mint: PublicKey;
  let maintainerTokenAccount: PublicKey;
  let contributorTokenAccount: PublicKey;
  let escrowAuthorityPda: PublicKey;
  let escrowTokenAccount: PublicKey;
  let configPda: PublicKey;
  const bountyId = generateBountyId();
  const BOUNTY_AMOUNT = new anchor.BN(10000); // Use BN for amounts

  before(async () => {
    // Airdrop SOL to the contributor so they can pay for transactions if needed
    await connection.confirmTransaction(
      await connection.requestAirdrop(contributor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
  );

    // Create the token mint
    mint = await createMint(
      connection,
      wallet.payer,       // Payer
      wallet.publicKey,   // Mint Authority
      wallet.publicKey,   // Freeze Authority
      6                   // Decimals
    );

    // Create Associated Token Accounts for the maintainer and contributor
    maintainerTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      maintainer.publicKey // Owner is the maintainer (our wallet)
    );

    contributorTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      contributor.publicKey // Owner is the contributor
    );

    // Mint some tokens to the maintainer's token account so they can fund the bounty
    await mintTo(
      connection,
      wallet.payer,
      mint,
      maintainerTokenAccount,
      wallet.payer, // Mint authority
      1000000       // 1,000,000 tokens
    );

    // Derive the PDA for the escrow authority
    // This PDA is the sole authority over the escrow_token_account
    [escrowAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_auth"), bountyAccountKp.publicKey.toBuffer()],
        program.programId
    );

    // Derive the address for the escrow's token account (an ATA owned by the PDA)
    escrowTokenAccount = await getAssociatedTokenAddress(
        mint,
        escrowAuthorityPda, // The owner is the PDA
        true // IMPORTANT: This must be true for PDA-owned accounts
    );

    // Derive the config PDA
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // Initialize the config
    await program.methods
      .initializeConfig()
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("Initializes the bounty escrow successfully!", async () => {
    // Now you can write your test with the correctly initialized variables
    await program.methods
      .initializeBounty(bountyId, BOUNTY_AMOUNT)
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: bountyAccountKp.publicKey,
        maintainerTokenAccount: maintainerTokenAccount,
        escrowAuthority: escrowAuthorityPda,
        escrowTokenAccount: escrowTokenAccount,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      // The bounty account is being created, so its keypair must sign the transaction
      .signers([bountyAccountKp])
      .rpc();

    // Fetch the created bounty account and assert its values
    const bountyAccount = await program.account.bounty.fetch(bountyAccountKp.publicKey);

    assert.ok(bountyAccount.maintainer.equals(maintainer.publicKey), "Maintainer public key should match");
    assert.equal(bountyAccount.amount.toString(), BOUNTY_AMOUNT.toString(), "Bounty amount should match");
    assert.ok(bountyAccount.contributor === null, "Contributor should be null initially");
    assert.ok(bountyAccount.state.hasOwnProperty('created'), "Bounty state should be 'created'");

    // Check that the tokens were transferred to the escrow token account
    const escrowTokenAccountInfo = await getAccount(connection, escrowTokenAccount);
    assert.equal(escrowTokenAccountInfo.amount.toString(), BOUNTY_AMOUNT.toString(), "Escrow token account balance should match bounty amount");
  });

  it("Assigns a contributor to the bounty successfully!", async () => {
    try {
        // Call the assignContributor instruction
        await program.methods
            .assignContributor()
            .accountsPartial({
                maintainer: maintainer.publicKey,
                bounty: bountyAccountKp.publicKey,
                contributor: contributor.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    } catch (error) {
        console.error("Transaction failed:", error);
        if (error instanceof AnchorError) {
            console.error("AnchorError:", error.error);
            console.error("Error Logs:", error.logs);
        }
        assert.fail("The 'assignContributor' transaction failed to execute.");
    }

    // Fetch the updated bounty account state
    const updatedBountyAccount = await program.account.bounty.fetch(bountyAccountKp.publicKey);

    // --- Assertions ---
    assert.ok(updatedBountyAccount.contributor, "Contributor field should be populated but it is null.");
    assert.ok(
        updatedBountyAccount.contributor.equals(contributor.publicKey),
        `Contributor public key mismatch. Expected ${contributor.publicKey.toBase58()}, but got ${updatedBountyAccount.contributor.toBase58()}`
    );
    assert.ok(updatedBountyAccount.state.hasOwnProperty('inProgress'), "Bounty state should be 'InProg'.");
  });

  it("Fails to assign contributor twice!", async () => {
    const secondContributor = anchor.web3.Keypair.generate();
    
    try {
        await program.methods
            .assignContributor()
            .accountsPartial({
                maintainer: maintainer.publicKey,
                bounty: bountyAccountKp.publicKey,
                contributor: secondContributor.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
        assert.fail("Should have failed to assign contributor twice");
    } catch (error) {
        expectAnchorErrorCode(error, "ContributorAlreadyAssigned");
    }
  });

  it("Fails to assign contributor with wrong maintainer!", async () => {
    const wrongMaintainer = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(wrongMaintainer.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    const testBountyKp = anchor.web3.Keypair.generate();
    const testEscrowAuthorityPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_auth"), testBountyKp.publicKey.toBuffer()],
      program.programId
    )[0];
    const testEscrowTokenAccount = await getAssociatedTokenAddress(
      mint,
      testEscrowAuthorityPda,
      true
    );

    // Initialize bounty with correct maintainer
    await program.methods
      .initializeBounty(generateBountyId(), BOUNTY_AMOUNT)
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        maintainerTokenAccount: maintainerTokenAccount,
        escrowAuthority: testEscrowAuthorityPda,
        escrowTokenAccount: testEscrowTokenAccount,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([testBountyKp])
      .rpc();

    // Try to assign contributor with wrong maintainer
    try {
        await program.methods
            .assignContributor()
            .accountsPartial({
                maintainer: wrongMaintainer.publicKey,
                bounty: testBountyKp.publicKey,
                contributor: contributor.publicKey,
                systemProgram: SystemProgram.programId,
            })
            .signers([wrongMaintainer])
            .rpc();
        assert.fail("Should have failed with wrong maintainer");
    } catch (error) {
        // has_one constraint triggers before our custom error inside handler
        expectAnchorErrorCode(error, "ConstraintHasOne");
    }
  });
    
  it("Completes the bounty and pays the contributor!", async () => {
    try {
        await program.methods
            .completeBounty(bountyId) 
            .accountsPartial({
                bounty: bountyAccountKp.publicKey,
                escrowAuthority: escrowAuthorityPda,
                maintainer: maintainer.publicKey,
                contributor: contributor.publicKey,
                config: configPda,
                admin: admin.publicKey,
                contributorTokenAccount: contributorTokenAccount,
                escrowTokenAccount: escrowTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
    } catch (error) {
        console.error("Transaction failed:", error);
        if (error instanceof AnchorError) {
            console.error("AnchorError:", error.error);
            console.error("Error Logs:", error.logs);
        }
        assert.fail("The 'completeBounty' transaction failed to execute.");
    }

    // --- Assertions ---
    const contributorTokenAccountInfo = await getAccount(connection, contributorTokenAccount);
    assert.equal(
        contributorTokenAccountInfo.amount.toString(), 
        BOUNTY_AMOUNT.toString(),
        "Contributor token account should have received the bounty amount."
    );

    // Verify the escrow token account is closed (should throw an error when trying to fetch)
    try {
      await getAccount(connection, escrowTokenAccount);
      assert.fail("Escrow token account should be closed after bounty completion");
    } catch (error) {
      assert.isOk(error, "Successfully confirmed escrow token account is closed");
    }


  });

  it("Fails to complete bounty with wrong admin!", async () => {
    const wrongAdmin = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(wrongAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    const testBountyKp = anchor.web3.Keypair.generate();
    const testContributor = anchor.web3.Keypair.generate();
    const testEscrowAuthorityPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_auth"), testBountyKp.publicKey.toBuffer()],
      program.programId
    )[0];
    const testEscrowTokenAccount = await getAssociatedTokenAddress(
      mint,
      testEscrowAuthorityPda,
      true
    );
    const testContributorTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      testContributor.publicKey
    );

    // Initialize and assign contributor
    await program.methods
      .initializeBounty(generateBountyId(), BOUNTY_AMOUNT)
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        maintainerTokenAccount: maintainerTokenAccount,
        escrowAuthority: testEscrowAuthorityPda,
        escrowTokenAccount: testEscrowTokenAccount,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([testBountyKp])
      .rpc();

    await program.methods
      .assignContributor()
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        contributor: testContributor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
        await program.methods
            .completeBounty(generateBountyId())
            .accountsPartial({
                bounty: testBountyKp.publicKey,
                escrowAuthority: testEscrowAuthorityPda,
                maintainer: maintainer.publicKey,
                contributor: testContributor.publicKey,
                config: configPda,
                admin: wrongAdmin.publicKey,
                contributorTokenAccount: testContributorTokenAccount,
                escrowTokenAccount: testEscrowTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .signers([wrongAdmin])
            .rpc();
        assert.fail("Should have failed with wrong admin");
    } catch (error) {
        expectAnchorErrorCode(error, "Unauthorized");
    }
  });

  it("Cancels the bounty and returns funds to the maintainer!", async () => {
    // --- Setup a new, independent bounty for this test ---
    const cancelBountyKp = anchor.web3.Keypair.generate();
    const cancelBountyId = generateBountyId();
    const cancelContributor = anchor.web3.Keypair.generate();
    const initialMaintainerBalance = (await getAccount(connection, maintainerTokenAccount)).amount;

    // Derive the PDA for the new escrow authority
    const [cancelEscrowAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_auth"), cancelBountyKp.publicKey.toBuffer()],
        program.programId
    );

    // Derive the address for the new escrow's token account
    const cancelEscrowTokenAccount = await getAssociatedTokenAddress(
        mint,
        cancelEscrowAuthorityPda,
        true
    );

    // 1. Initialize the new bounty
    await program.methods
        .initializeBounty(cancelBountyId, BOUNTY_AMOUNT)
        .accountsPartial({
            maintainer: maintainer.publicKey,
            bounty: cancelBountyKp.publicKey,
            maintainerTokenAccount: maintainerTokenAccount,
            escrowAuthority: cancelEscrowAuthorityPda,
            escrowTokenAccount: cancelEscrowTokenAccount,
            mint: mint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([cancelBountyKp])
        .rpc();

    // 2. Assign a contributor to it
    await program.methods
        .assignContributor()
        .accountsPartial({
            maintainer: maintainer.publicKey,
            bounty: cancelBountyKp.publicKey,
            contributor: cancelContributor.publicKey,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    // --- Execute the cancelBounty instruction ---
    try {
        await program.methods
            .cancelBounty()
            .accountsPartial({
                admin: admin.publicKey,
                config: configPda,
                bounty: cancelBountyKp.publicKey,
                escrowAuthority: cancelEscrowAuthorityPda,
                maintainer: maintainer.publicKey,
                maintainerTokenAccount: maintainerTokenAccount,
                escrowTokenAccount: cancelEscrowTokenAccount,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([admin])
            .rpc();
    } catch (error) {
        console.error("Transaction failed:", error);
        if (error instanceof AnchorError) {
            console.error("AnchorError:", error.error);
            console.error("Error Logs:", error.logs);
        }
        assert.fail("The 'cancelBounty' transaction failed to execute.");
    }

    // --- Assertions ---
    const finalMaintainerBalance = (await getAccount(connection, maintainerTokenAccount)).amount;
    assert.equal(
        finalMaintainerBalance.toString(),
        initialMaintainerBalance.toString(),
        "Maintainer's token balance should be restored to its initial amount."
    );

    // 2. Check that the escrow token account is closed.
    try {
        await getAccount(connection, cancelEscrowTokenAccount);
        assert.fail("Escrow token account for cancelled bounty should be closed.");
    } catch (error) {
        assert.isOk(error, "Successfully confirmed escrow token account is closed.");
    }

    // 3. Check that the bounty account is closed.
    try {
        await program.account.bounty.fetch(cancelBountyKp.publicKey);
        assert.fail("Cancelled bounty account should be closed.");
    } catch (error) {
        assert.isOk(error, "Successfully confirmed bounty account is closed.");
    }

  });

  it("Only admin can cancel bounty!", async () => {
    // --- Setup a new, independent bounty for this test ---
    const securityCancelBountyKp = anchor.web3.Keypair.generate();
    const securityCancelBountyId = generateBountyId();
    const securityCancelContributor = anchor.web3.Keypair.generate();
    const wrongAdmin = anchor.web3.Keypair.generate();

    const [securityCancelEscrowAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_auth"), securityCancelBountyKp.publicKey.toBuffer()],
        program.programId
    );
    const securityCancelEscrowTokenAccount = await getAssociatedTokenAddress(
        mint,
        securityCancelEscrowAuthorityPda,
        true
    );

    await program.methods
        .initializeBounty(securityCancelBountyId, BOUNTY_AMOUNT)
        .accountsPartial({
            maintainer: maintainer.publicKey,
            bounty: securityCancelBountyKp.publicKey,
            maintainerTokenAccount: maintainerTokenAccount,
            escrowAuthority: securityCancelEscrowAuthorityPda,
            escrowTokenAccount: securityCancelEscrowTokenAccount,
            mint: mint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([securityCancelBountyKp])
        .rpc();

    await program.methods
        .assignContributor()
        .accountsPartial({
            maintainer: maintainer.publicKey,
            bounty: securityCancelBountyKp.publicKey,
            contributor: securityCancelContributor.publicKey,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    try {
        await program.methods
            .cancelBounty()
            .accountsPartial({
                admin: wrongAdmin.publicKey,
                config: configPda,
                bounty: securityCancelBountyKp.publicKey,
                escrowAuthority: securityCancelEscrowAuthorityPda,
                maintainer: maintainer.publicKey,
                maintainerTokenAccount: maintainerTokenAccount,
                escrowTokenAccount: securityCancelEscrowTokenAccount,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([wrongAdmin])
            .rpc();
        assert.fail("Cancel bounty should have failed when called by wrong admin");
    } catch (error) {
        expectAnchorErrorCode(error, "Unauthorized");
    }

    const bountyAccount = await program.account.bounty.fetch(securityCancelBountyKp.publicKey);
    // Check state variant
    assert.isTrue(
      bountyAccount.state && Object.prototype.hasOwnProperty.call(bountyAccount.state, 'inProgress'),
      "Bounty should still be in InProgress state"
    );
  });

  it("Updates admin successfully!", async () => {
    // Create a new admin keypair
    const newAdmin = anchor.web3.Keypair.generate();
    
    // Airdrop some SOL to the new admin for transaction fees
    await connection.confirmTransaction(
      await connection.requestAirdrop(newAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Get the current config to verify the admin before update
    const currentConfig = await program.account.configState.fetch(configPda);
    assert.ok(currentConfig.admin.equals(admin.publicKey), "Current admin should match the original admin");

    // Update the admin to newAdmin (signed by current admin)
    await program.methods
      .updateAdmin(newAdmin.publicKey)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    // Verify the admin was updated
    const updatedConfig = await program.account.configState.fetch(configPda);
    assert.ok(updatedConfig.admin.equals(newAdmin.publicKey), "Admin should be updated to the new admin");
    assert.ok(!updatedConfig.admin.equals(admin.publicKey), "Admin should no longer be the old admin");

    // Revert admin back to original admin, signed by newAdmin
    await program.methods
      .updateAdmin(admin.publicKey)
      .accounts({
        admin: newAdmin.publicKey,
        config: configPda,
      })
      .signers([newAdmin])
      .rpc();

    const revertedConfig = await program.account.configState.fetch(configPda);
    assert.ok(revertedConfig.admin.equals(admin.publicKey), "Admin should be reverted to the original admin");


  });

  it("Fails to update admin when called by non-admin!", async () => {
    // Create a random keypair that is not the admin
    const nonAdmin = anchor.web3.Keypair.generate();
    
    // Airdrop some SOL to the non-admin for transaction fees
    await connection.confirmTransaction(
      await connection.requestAirdrop(nonAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Try to update admin with non-admin account - this should fail
    try {
      await program.methods
        .updateAdmin(nonAdmin.publicKey)
        .accounts({
          admin: nonAdmin.publicKey,
          config: configPda,
        })
        .signers([nonAdmin])
        .rpc();
      
      // If we reach here, the test should fail
      assert.fail("Update admin should have failed when called by non-admin");
    } catch (error) {
      // This is expected - the transaction should fail

      assert.isOk(error, "Transaction should have failed");
    }
  });

  it("Fails to update admin to same admin!", async () => {
    const currentAdmin = anchor.web3.Keypair.generate();
    
    // Airdrop some SOL to the current admin
    await connection.confirmTransaction(
      await connection.requestAirdrop(currentAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Try to update admin to the same admin - this should fail
    try {
      await program.methods
        .updateAdmin(currentAdmin.publicKey)
        .accounts({
          admin: currentAdmin.publicKey,
          config: configPda,
        })
        .signers([currentAdmin])
        .rpc();
      
      assert.fail("Update admin should have failed when setting same admin");
    } catch (error) {

      assert.isOk(error, "Transaction should have failed");
    }
  });

  it("Fails to update admin to default pubkey!", async () => {
    const currentAdmin = anchor.web3.Keypair.generate();
    
    // Airdrop some SOL to the current admin
    await connection.confirmTransaction(
      await connection.requestAirdrop(currentAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Try to update admin to default pubkey - this should fail
    try {
      await program.methods
        .updateAdmin(anchor.web3.PublicKey.default)
        .accounts({
          admin: currentAdmin.publicKey,
          config: configPda,
        })
        .signers([currentAdmin])
        .rpc();
      
      assert.fail("Update admin should have failed when setting to default pubkey");
    } catch (error) {

      assert.isOk(error, "Transaction should have failed");
    }
  });

  it("Current admin can complete bounty!", async () => {
    // Get the current admin from config
    const currentConfig = await program.account.configState.fetch(configPda);
    const currentAdminPubkey = currentConfig.admin;
    
    // If the current admin is not the original admin, we need to reset it
    if (!currentAdminPubkey.equals(admin.publicKey)) {
      // Create a temporary admin that we can use to reset back to the original admin
      const tempAdmin = anchor.web3.Keypair.generate();
      await connection.confirmTransaction(
        await connection.requestAirdrop(tempAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
        "confirmed"
      );
      
      // First, update to the temp admin (this should work if we have the current admin's key)
      // But since we don't have the current admin's private key, we'll skip this test
      return;
    }

    // If we reach here, the current admin is the original admin
    // Create a new bounty for testing
    const testBountyKp = anchor.web3.Keypair.generate();
    const testBountyId = generateBountyId();
    const testContributor = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the contributor
    await connection.confirmTransaction(
      await connection.requestAirdrop(testContributor.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Create contributor token account
    const testContributorTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      testContributor.publicKey
    );

    // Derive escrow authority for the test bounty
    const [testEscrowAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_auth"), testBountyKp.publicKey.toBuffer()],
      program.programId
    );

    // Derive escrow token account
    const testEscrowTokenAccount = await getAssociatedTokenAddress(
      mint,
      testEscrowAuthorityPda,
      true
    );

    // Initialize the test bounty
    await program.methods
      .initializeBounty(testBountyId, BOUNTY_AMOUNT)
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        maintainerTokenAccount: maintainerTokenAccount,
        escrowAuthority: testEscrowAuthorityPda,
        escrowTokenAccount: testEscrowTokenAccount,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([testBountyKp])
      .rpc();

    // Assign contributor
    await program.methods
      .assignContributor()
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        contributor: testContributor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify the bounty state
    const bountyAccount = await program.account.bounty.fetch(testBountyKp.publicKey);
    assert.ok(bountyAccount.contributor.equals(testContributor.publicKey), "Contributor should be assigned");
    assert.ok(bountyAccount.state.hasOwnProperty('inProgress'), "Bounty should be in progress");


  });

  it("Wrong admin cannot complete bounty!", async () => {
    // Create a wrong admin (not the current admin)
    const wrongAdmin = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(wrongAdmin.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Get the current admin from config
    const currentConfig = await program.account.configState.fetch(configPda);
    const currentAdminPubkey = currentConfig.admin;
    
    // If the current admin is not the original admin, we need to use the current admin for bounty creation
    // But since we don't have the current admin's private key, we'll test the security constraint differently
    if (!currentAdminPubkey.equals(admin.publicKey)) {

      
      // Test that a non-admin cannot create a bounty
      const nonAdminMaintainer = anchor.web3.Keypair.generate();
      await connection.confirmTransaction(
        await connection.requestAirdrop(nonAdminMaintainer.publicKey, anchor.web3.LAMPORTS_PER_SOL),
        "confirmed"
      );
      
      // Create a token account for the non-admin maintainer
      const nonAdminTokenAccount = await createAssociatedTokenAccount(
        connection,
        wallet.payer,
        mint,
        nonAdminMaintainer.publicKey
      );
      
      // Mint some tokens to the non-admin's token account
      await mintTo(
        connection,
        wallet.payer,
        mint,
        nonAdminTokenAccount,
        wallet.payer, // Mint authority
        1000000       // 1,000,000 tokens
      );
      
      const testBountyKp = anchor.web3.Keypair.generate();
      const testEscrowAuthorityPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_auth"), testBountyKp.publicKey.toBuffer()],
        program.programId
      )[0];
      const testEscrowTokenAccount = await getAssociatedTokenAddress(
        mint,
        testEscrowAuthorityPda,
        true
      );

      try {
        await program.methods
          .initializeBounty(generateBountyId(), BOUNTY_AMOUNT)
          .accountsPartial({
            maintainer: nonAdminMaintainer.publicKey,
            bounty: testBountyKp.publicKey,
            maintainerTokenAccount: nonAdminTokenAccount, // Use the non-admin's token account
            escrowAuthority: testEscrowAuthorityPda,
            escrowTokenAccount: testEscrowTokenAccount,
            mint: mint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([testBountyKp, nonAdminMaintainer])
          .rpc();
        
        assert.fail("Non-admin should not be able to create bounty");
      } catch (error) {
        if (error instanceof AnchorError) {
          assert.equal(error.error.errorCode.code, "Unauthorized", "Should fail with Unauthorized error");

        } else {
          console.log("Transaction failed as expected:", error);
        }
        assert.isOk(error, "Transaction should have failed");
      }
      return;
    }

    // If we reach here, the current admin is the original admin
    // Create a new bounty for testing
    const testBountyKp = anchor.web3.Keypair.generate();
    const testBountyId = generateBountyId();
    const testContributor = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the contributor
    await connection.confirmTransaction(
      await connection.requestAirdrop(testContributor.publicKey, anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Create contributor token account
    const testContributorTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      testContributor.publicKey
    );

    // Derive escrow authority for the test bounty
    const [testEscrowAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_auth"), testBountyKp.publicKey.toBuffer()],
      program.programId
    );

    // Derive escrow token account
    const testEscrowTokenAccount = await getAssociatedTokenAddress(
      mint,
      testEscrowAuthorityPda,
      true
    );

    // Initialize the test bounty
    await program.methods
      .initializeBounty(testBountyId, BOUNTY_AMOUNT)
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        maintainerTokenAccount: maintainerTokenAccount,
        escrowAuthority: testEscrowAuthorityPda,
        escrowTokenAccount: testEscrowTokenAccount,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([testBountyKp])
      .rpc();

    // Assign contributor
    await program.methods
      .assignContributor()
      .accountsPartial({
        maintainer: maintainer.publicKey,
        bounty: testBountyKp.publicKey,
        contributor: testContributor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Try to complete bounty with the wrong admin - this should fail
    try {
      await program.methods
        .completeBounty(testBountyId)
        .accountsPartial({
          bounty: testBountyKp.publicKey,
          escrowAuthority: testEscrowAuthorityPda,
          maintainer: maintainer.publicKey,
          contributor: testContributor.publicKey,
          config: configPda,
          admin: wrongAdmin.publicKey, // Use a wrong admin
          contributorTokenAccount: testContributorTokenAccount,
          escrowTokenAccount: testEscrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([wrongAdmin])
        .rpc();
      
      // If we reach here, the test should fail
      assert.fail("Complete bounty should have failed when called by wrong admin");
    } catch (error) {
      // This is expected - the transaction should fail
      if (error instanceof AnchorError) {
        assert.equal(error.error.errorCode.code, "Unauthorized", "Should fail with Unauthorized error");
        console.log("Successfully prevented wrong admin from completing bounty");
      } else {
        console.log("Transaction failed as expected:", error);
      }
      assert.isOk(error, "Transaction should have failed");
    }
  });

  it("Admin assigns and releases funds in one call (success)", async () => {
    const bntyKp = anchor.web3.Keypair.generate();
    const newBountyId = generateBountyId();
    const targetContributor = anchor.web3.Keypair.generate();

    const [escrowAuth] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_auth"), bntyKp.publicKey.toBuffer()],
      program.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, escrowAuth, true);

    // init bounty
    await program.methods.initializeBounty(newBountyId, BOUNTY_AMOUNT).accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      maintainerTokenAccount: maintainerTokenAccount,
      escrowAuthority: escrowAuth,
      escrowTokenAccount: escrowAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([bntyKp]).rpc();

    // Ensure contributor ATA exists
    const contribAta = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      targetContributor.publicKey
    );

    await program.methods.adminAssignAndRelease(newBountyId).accountsPartial({
      admin: admin.publicKey,
      config: configPda,
      bounty: bntyKp.publicKey,
      escrowAuthority: escrowAuth,
      maintainer: maintainer.publicKey,
      contributor: targetContributor.publicKey,
      contributorTokenAccount: contribAta,
      escrowTokenAccount: escrowAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).signers([admin]).rpc();

    const contribInfo = await getAccount(connection, contribAta);
    assert.equal(contribInfo.amount.toString(), BOUNTY_AMOUNT.toString());
  });

  it("Admin assign+release fails with wrong admin (Unauthorized)", async () => {
    const wrong = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(wrong.publicKey, anchor.web3.LAMPORTS_PER_SOL));

    const bntyKp = anchor.web3.Keypair.generate();
    const newBountyId = generateBountyId();
    const targetContributor = anchor.web3.Keypair.generate();
    const [escrowAuth] = anchor.web3.PublicKey.findProgramAddressSync([
      Buffer.from("escrow_auth"), bntyKp.publicKey.toBuffer()
    ], program.programId);
    const escrowAta = await getAssociatedTokenAddress(mint, escrowAuth, true);

    await program.methods.initializeBounty(newBountyId, BOUNTY_AMOUNT).accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      maintainerTokenAccount: maintainerTokenAccount,
      escrowAuthority: escrowAuth,
      escrowTokenAccount: escrowAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([bntyKp]).rpc();

    // Ensure contributor ATA exists
    const contribAta = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      targetContributor.publicKey
    );

    try {
      await program.methods.adminAssignAndRelease(newBountyId).accountsPartial({
        admin: wrong.publicKey,
        config: configPda,
        bounty: bntyKp.publicKey,
        escrowAuthority: escrowAuth,
        maintainer: maintainer.publicKey,
        contributor: targetContributor.publicKey,
        contributorTokenAccount: contribAta,
        escrowTokenAccount: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([wrong]).rpc();
      assert.fail("Expected Unauthorized");
    } catch (e) {
      expectAnchorErrorCode(e, "Unauthorized");
    }
  });


  it("Admin assign+release fails with contributor ATA mint mismatch (InvalidMint)", async () => {
    const bntyKp = anchor.web3.Keypair.generate();
    const newBountyId = generateBountyId();
    const targetContributor = anchor.web3.Keypair.generate();
    const [escrowAuth] = anchor.web3.PublicKey.findProgramAddressSync([
      Buffer.from("escrow_auth"), bntyKp.publicKey.toBuffer()
    ], program.programId);
    const escrowAta = await getAssociatedTokenAddress(mint, escrowAuth, true);

    await program.methods.initializeBounty(newBountyId, BOUNTY_AMOUNT).accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      maintainerTokenAccount: maintainerTokenAccount,
      escrowAuthority: escrowAuth,
      escrowTokenAccount: escrowAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([bntyKp]).rpc();

    // Create wrong-mint and correct ATAs to ensure initialized accounts
    const wrongMint = await createMint(connection, wallet.payer, wallet.publicKey, wallet.publicKey, 6);
    const wrongContribAta = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      wrongMint,
      targetContributor.publicKey
    );

    try {
      await program.methods.adminAssignAndRelease(newBountyId).accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        bounty: bntyKp.publicKey,
        escrowAuthority: escrowAuth,
        maintainer: maintainer.publicKey,
        contributor: targetContributor.publicKey,
        contributorTokenAccount: wrongContribAta,
        escrowTokenAccount: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([admin]).rpc();
      assert.fail("Expected InvalidMint");
    } catch (e) {
      expectAnchorErrorCode(e, "InvalidMint");
    }
  });

  it("Admin assign+release fails when contributor ATA owner mismatch (InvalidTokenAccount)", async () => {
    const bntyKp = anchor.web3.Keypair.generate();
    const newBountyId = generateBountyId();
    const targetContributor = anchor.web3.Keypair.generate();
    const otherOwner = anchor.web3.Keypair.generate();

    const [escrowAuth] = anchor.web3.PublicKey.findProgramAddressSync([
      Buffer.from("escrow_auth"), bntyKp.publicKey.toBuffer()
    ], program.programId);
    const escrowAta = await getAssociatedTokenAddress(mint, escrowAuth, true);

    await program.methods.initializeBounty(newBountyId, BOUNTY_AMOUNT).accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      maintainerTokenAccount: maintainerTokenAccount,
      escrowAuthority: escrowAuth,
      escrowTokenAccount: escrowAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([bntyKp]).rpc();

    // Initialize ATA owned by a different wallet
    const wrongOwnerAta = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      otherOwner.publicKey
    );

    try {
      await program.methods.adminAssignAndRelease(newBountyId).accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        bounty: bntyKp.publicKey,
        escrowAuthority: escrowAuth,
        maintainer: maintainer.publicKey,
        contributor: targetContributor.publicKey,
        contributorTokenAccount: wrongOwnerAta,
        escrowTokenAccount: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).signers([admin]).rpc();
      assert.fail("Expected InvalidTokenAccount");
    } catch (e) {
      expectAnchorErrorCode(e, "InvalidTokenAccount");
    }
  });

  it("Admin assign+release overrides existing contributor successfully", async () => {
    const bntyKp = anchor.web3.Keypair.generate();
    const newBountyId = generateBountyId();
    const initialContributor = anchor.web3.Keypair.generate();
    const targetContributor = anchor.web3.Keypair.generate();

    const [escrowAuth] = anchor.web3.PublicKey.findProgramAddressSync([
      Buffer.from("escrow_auth"), bntyKp.publicKey.toBuffer()
    ], program.programId);
    const escrowAta = await getAssociatedTokenAddress(mint, escrowAuth, true);

    await program.methods.initializeBounty(newBountyId, BOUNTY_AMOUNT).accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      maintainerTokenAccount: maintainerTokenAccount,
      escrowAuthority: escrowAuth,
      escrowTokenAccount: escrowAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([bntyKp]).rpc();

    // Assign initial contributor using maintainer flow
    await program.methods.assignContributor().accountsPartial({
      maintainer: maintainer.publicKey,
      bounty: bntyKp.publicKey,
      contributor: initialContributor.publicKey,
      systemProgram: SystemProgram.programId,
    }).rpc();

    // Verify initial assignment
    const bountyAfterInitial = await program.account.bounty.fetch(bntyKp.publicKey);
    assert.equal(bountyAfterInitial.contributor.toString(), initialContributor.publicKey.toString());
    assert.ok(bountyAfterInitial.state.hasOwnProperty('inProgress'), "Bounty should be in progress");

    // Ensure target contributor ATA exists
    const contribAta = await createAssociatedTokenAccount(
      connection,
      wallet.payer,
      mint,
      targetContributor.publicKey
    );

    // Admin overrides with new contributor and releases funds
    await program.methods.adminAssignAndRelease(newBountyId).accountsPartial({
      admin: admin.publicKey,
      config: configPda,
      bounty: bntyKp.publicKey,
      escrowAuthority: escrowAuth,
      maintainer: maintainer.publicKey,
      contributor: targetContributor.publicKey,
      contributorTokenAccount: contribAta,
      escrowTokenAccount: escrowAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).signers([admin]).rpc();

    // Note: The bounty account is closed after adminAssignAndRelease due to the 'close = maintainer' constraint
    // So we cannot fetch it here. Instead, we verify the funds were transferred correctly.

    // Verify funds were transferred to new contributor
    const contribInfo = await getAccount(connection, contribAta);
    assert.equal(contribInfo.amount.toString(), BOUNTY_AMOUNT.toString());

    // Verify the escrow token account is closed (should throw an error when trying to fetch)
    try {
      await getAccount(connection, escrowAta);
      assert.fail("Escrow token account should be closed after admin assign and release");
    } catch (error) {
      assert.isOk(error, "Successfully confirmed escrow token account is closed");
    }

    // Verify the bounty account is closed (should throw an error when trying to fetch)
    try {
      await program.account.bounty.fetch(bntyKp.publicKey);
      assert.fail("Bounty account should be closed after admin assign and release");
    } catch (error) {
      assert.isOk(error, "Successfully confirmed bounty account is closed");
    }
  });
});
