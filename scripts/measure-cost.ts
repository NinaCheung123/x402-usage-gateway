/**
 * Measures what the facilitator really spends in SOL: fees on each recent
 * transaction, and its balance right now (rent comes back when channels close).
 */
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import "dotenv/config";

const FACILITATOR = (await createKeyPairSignerFromBytes(base58.decode(process.env.FACILITATOR_KEY!.trim()))).address;
const FACILITATOR_KEY = new PublicKey(FACILITATOR);
const conn = new Connection(process.env.RPC_SHIELD_URL ?? "http://localhost:8899", "confirmed");

const sigs = await conn.getSignaturesForAddress(FACILITATOR_KEY, { limit: 12 });
let total = 0;
let counted = 0;
for (const s of sigs) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 } as never);
  if (!tx?.meta) continue;
  const i = tx.transaction.message.staticAccountKeys.findIndex((k) => k.equals(FACILITATOR_KEY));
  const delta = i >= 0 ? tx.meta.postBalances[i]! - tx.meta.preBalances[i]! : 0;
  console.log(`${s.signature.slice(0, 10)}  fee ${tx.meta.fee} lamports  facilitator balance change ${delta}  ${s.err ? "FAILED" : "ok"}`);
  total += tx.meta.fee;
  counted++;
}
console.log(`average fee: ${counted ? total / counted : 0} lamports per transaction (1 SOL = 1e9 lamports)`);
console.log(`facilitator balance now: ${(await conn.getBalance(FACILITATOR_KEY)) / 1e9} SOL`);
