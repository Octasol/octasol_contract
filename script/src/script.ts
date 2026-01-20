import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import dotenv from 'dotenv'
import idl from '../../target/idl/octasol_contract.json'

import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet' 
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import * as readline from 'readline';
dotenv.config();

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const parsed: { [key: string]: string } = {};
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--update') {
            parsed.update = 'true'; // Just mark that update flag is present
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                parsed.updatePublicKey = args[i + 1];
                i++; // Skip the next argument since we consumed it
            }
        } else if (args[i] === '--show') {
            parsed.show = 'true';
        } else if (args[i] === '--init') {
            parsed.init = 'true';
        }
    }
    
    return parsed;
}

// Function to prompt user for input
function promptUser(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function main(){
    const args = parseArgs();

    const ADMIN_PRIVATE_KEY =process.env.PRIVATE_KEY!; 
    
    const privateKeyBuffer = bs58.decode(ADMIN_PRIVATE_KEY);
    const adminKeypair = Keypair.fromSecretKey(privateKeyBuffer);
    const adminWallet = new NodeWallet(adminKeypair);

    const CHAIN_URL = process.env.CHAIN_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(CHAIN_URL);
    
    const provider = new AnchorProvider(connection, adminWallet, {
        preflightCommitment:'confirmed',
        commitment:'confirmed'
    })

    const program = new Program(idl, provider);

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // Check if --show flag is provided
    if (args.show) {
        try {
            console.log("Fetching current admin...");
            
            // Fetch the config account data using connection directly
            const accountInfo = await connection.getAccountInfo(configPda);
            if (!accountInfo) {
                throw new Error("Config account not found. It might not be initialized yet.");
            }
            
            // Parse the account data manually
            const accountData = accountInfo.data
            // Skip the discriminator (first 8 bytes)
            const adminPubkeyBytes = accountData.slice(8, 40);
            const adminPubkey = new PublicKey(adminPubkeyBytes);
            
            console.log("=== Current Admin Information ===");
            console.log(`Admin Public Key: ${adminPubkey.toString()}`);
            console.log(`Config PDA: ${configPda.toString()}`);
            console.log("================================");
        } catch (error) {
            console.error("Error fetching admin:", error);
            console.log("This might mean the config hasn't been initialized yet.");
            process.exit(1);
        }
    }
    // Check if --update flag is provided
    if (args.update) {
        try {
            let newAdminPublicKey: string;
            
            if (args.updatePublicKey) {
                newAdminPublicKey = args.updatePublicKey;
            } else {
                // Prompt user for the new admin public key
                newAdminPublicKey = await promptUser("Enter the new admin's public key: ");
            }
            
            const newAdminPubKey = new PublicKey(newAdminPublicKey);
            console.log(`Current admin: ${adminWallet.publicKey.toString()}`);
            console.log(`Updating admin to: ${newAdminPubKey.toString()}`);
            
            // Create the instruction
            const updateAdminIx = await program.methods
                .updateAdmin(newAdminPubKey)
                .accounts({
                    admin: adminWallet.publicKey,
                    config: configPda,
                })
                .instruction();
            
            // Create a new transaction
            const transaction = new Transaction();
            transaction.add(updateAdminIx);
            
            // Get the latest blockhash
            const { blockhash } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = adminWallet.publicKey;
            
            // Sign the transaction with the admin keypair
            transaction.sign(adminKeypair);
            
            // Send the transaction
            const txSignature = await connection.sendRawTransaction(transaction.serialize());
            
            // Wait for confirmation
            const confirmation = await connection.confirmTransaction(txSignature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }
                
            console.log(`Admin updated successfully! Transaction: ${txSignature}`);
        } catch (error) {
            console.error("Error updating admin:", error);
            process.exit(1);
        }
    } else if (args.init) {
        // Initialize config when --init flag is provided
        console.log("Initializing config...");
        const admin = await program.methods.initializeConfig().accounts({
            admin: adminWallet.publicKey,
            config: configPda
        }).rpc();
        console.log(`Config initialized successfully! Transaction: ${admin}`);
    } else {
        // No valid flag provided
        console.log("  npm run init   - Initialize the config");
        console.log("  npm run update - Update the admin");
        console.log("  npm run show   - Show current admin");
        process.exit(1);
    }
}

main();