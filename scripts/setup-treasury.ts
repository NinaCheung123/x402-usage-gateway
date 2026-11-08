/**
 * The payment-channel programme distributes through a treasury token account
 * for the channel's mint (error 2402 if it's missing). USDC already has one on
 * devnet; our own test token doesn't, so create it once. Anyone can pay to
 * create an associated token account; this gives us no control over it.
 * Devnet treasury owner comes from @x402/svm (DEVNET_TREASURY_OWNER).
 */
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { base58 } from "@scure/base";
import "dotenv/config";

const TREASURY_OWNER = new PublicKey("4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap");
const conn = new Connection(process.env.SVM_RPC_URL!, "confirmed");
const payer = Keypair.fromSecretKey(base58.decode(process.env.FACILITATOR_KEY!.trim()));
const mint = new PublicKey(process.env.TEST_MINT!);

const account = await getOrCreateAssociatedTokenAccount(conn, payer, mint, TREASURY_OWNER);
console.log("treasury token account", account.address.toBase58(), "balance", account.amount);
