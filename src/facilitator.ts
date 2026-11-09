/**
 * Self-hosted x402 facilitator on Solana devnet, for `upto` (one-off callers)
 * and `batch-settlement` (repeat callers). Based on the x402 Foundation's
 * official examples.
 *
 * Why self-hosted: the public facilitator (x402.org) only lists `exact` on
 * Solana devnet, and usage-based charging needs these two.
 */
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { discoverChannelsByRentPayer, toFacilitatorSvmSigner } from "@x402/svm";
import {
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
} from "@x402/svm/batch-settlement/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme } from "@x402/svm/upto/facilitator";
import "dotenv/config";
import express from "express";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { durableStorage } from "./durable.js";

const PORT = Number(process.env.FACILITATOR_PORT ?? 4022);
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DATA = process.env.DATA_DIR ?? "data";

const keyOf = (name: string) =>
  createKeyPairSignerFromBytes(base58.decode(process.env[name]!.trim()));

const account = await keyOf("FACILITATOR_KEY");
const receiverAuthorizer = await keyOf("RECEIVER_AUTHORIZER_KEY");
const signer = toFacilitatorSvmSigner(account, {
  defaultRpcUrl: process.env.RPC_SHIELD_URL ?? process.env.SVM_RPC_URL,
});

const uptoStorage = durableStorage(new InMemoryPaymentChannelStorage(), `${DATA}/facilitator-upto.json`);
const batchStorage = durableStorage(new InMemoryBatchChannelStorage(), `${DATA}/facilitator-batch.json`);

const upto = new UptoSvmScheme(signer, { channelStorage: uptoStorage, maxChannelLifetimeSecs: 3600 });
const batch = new BatchSvmScheme(signer, { channelStorage: batchStorage });

const facilitator = new x402Facilitator()
  .onVerifyFailure(async (c) => console.error("[verify failed]", c.error.message))
  .onSettleFailure(async (c) => console.error("[settle failed]", c.error.message));
facilitator.register(NETWORK, upto);
facilitator.register(NETWORK, batch);

/** The hash a channel commits to at open: one recipient taking 100%. */
function singleRecipientHash(recipient: string) {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(1);
  const bps = Buffer.alloc(2);
  bps.writeUInt16LE(10_000);
  return createHash("sha256").update(count).update(base58.decode(recipient)).update(bps).digest();
}

/**
 * Find open upto channels this facilitator paid for but has no record of, for
 * example from before records were durable, and hand them to cleanup. Cleanup
 * seals them at zero charge, which returns the agent's locked funds.
 *
 * x402's own discovery only picks up already-distributed channels. An open one
 * also needs its recipient, which the chain stores only as a hash, so this
 * tries each known seller against that hash.
 */
async function recoverOpenChannels() {
  const sellersFile = `${DATA}/sellers.json`;
  const sellers: string[] = [(await keyOf("SELLER_KEY")).address];
  if (existsSync(sellersFile))
    for (const s of JSON.parse(readFileSync(sellersFile, "utf8")) as { payTo: string }[]) sellers.push(s.payTo);
  const known = new Set((await uptoStorage.list(NETWORK)).map((r) => r.channelId));
  const found = await discoverChannelsByRentPayer(signer, NETWORK, account.address);
  let recovered = 0;
  for (const { channelId, channel } of found) {
    if (known.has(channelId) || channel.status !== 0) continue;
    if (channel.authorizedSigner !== receiverAuthorizer.address) continue; // Not an upto channel of ours.
    const onChainHash = Buffer.from(channel.distributionHash);
    const payTo = sellers.find((s) => singleRecipientHash(s).equals(onChainHash));
    if (!payTo) {
      console.warn(`[recovery] open channel ${channelId} matches no known seller; left alone`);
      continue;
    }
    await uptoStorage.recordActivity({
      network: NETWORK,
      channelId,
      payTo,
      tokenProgram: TOKEN_PROGRAM,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      lastActivityAt: 0,
      receiverAuthorizer: "",
      callerIdentity: "",
    });
    recovered++;
    console.log(`[recovery] handed channel ${channelId} to cleanup`);
  }
  console.log(`[recovery] scanned ${found.length} channels, recovered ${recovered}`);
}

const logCleanup = (label: string) => ({
  onClose: (r: { action: string; channelId: string; transaction: string }) =>
    console.log(`[${label}] ${r.action} channel=${r.channelId} tx=${r.transaction}`),
  onReclaim: (r: { channelIds: string[]; transaction: string }) =>
    console.log(`[${label}] reclaimed rent from ${r.channelIds.length} channels tx=${r.transaction}`),
  onError: (e: unknown) => console.error(`[${label}]`, e instanceof Error ? e.message : e),
});

const uptoCleanup = upto.createRentCleanupManager(NETWORK);
uptoCleanup.start({ intervalSecs: 30, abandonGraceSecs: 120, discoveryIntervalSecs: 3600, ...logCleanup("upto cleanup") });
const batchCleanup = batch.createRentCleanupManager(NETWORK);
batchCleanup.start({ intervalSecs: 60, abandonGraceSecs: 120, ...logCleanup("batch cleanup") });

const app = express();
app.use(express.json());

/**
 * Test only: makes a settlement land on-chain while reporting it unconfirmed.
 * That's exactly what a rate-limited RPC caused during development, and it
 * can't be triggered on demand any other way. x402 retries a pending settlement
 * with the same payload, so retries keep getting the same pending answer.
 */
let unconfirmAfterSettles = 0;
let failNextRefund = false;
const heldPending = new Map<string, unknown>();
if (process.env.ALLOW_SIMULATED_FAILURES === "true") {
  app.post("/test/unconfirm-next-call", (_req, res) => {
    unconfirmAfterSettles = 2; // upto settles twice per call: the lock, then the charge.
    res.json({ armed: true });
  });
  // Makes the next zero-charge settlement fail, leaving funds for cleanup to return.
  app.post("/test/fail-next-refund", (_req, res) => {
    failNextRefund = true;
    res.json({ armed: true });
  });
}

/**
 * A settlement that already succeeded stays successful. A retry of one would
 * otherwise fail ("channel is not open") and make a real charge look failed.
 */
const SETTLED_MEMORY_MS = 10 * 60 * 1000;
const settled = new Map<string, { result: unknown; at: number }>();
const payloadKey = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "verify error" });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (failNextRefund && paymentRequirements.amount === "0") {
      failNextRefund = false;
      return void res.json({ success: false, errorReason: "simulated_refund_failure", transaction: "", network: NETWORK });
    }
    const key = payloadKey({ paymentPayload, amount: paymentRequirements.amount });
    if (heldPending.has(key)) return void res.json(heldPending.get(key));
    // Only the final charge may be remembered. Answering a repeated deposit from
    // memory would let a replayed payment proof through to the AI model.
    const isCharge = (paymentPayload.payload as { type?: string } | undefined)?.type === "claim";
    const previous = isCharge ? settled.get(key) : undefined;
    if (previous && Date.now() - previous.at < SETTLED_MEMORY_MS) return void res.json(previous.result);

    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    console.log("[settle]", JSON.stringify({ ...result, extra: undefined }));
    if (result.success && isCharge) {
      settled.set(key, { result, at: Date.now() });
      for (const [k, v] of settled) if (Date.now() - v.at > SETTLED_MEMORY_MS) settled.delete(k);
    }
    if (unconfirmAfterSettles > 0 && --unconfirmAfterSettles === 0 && result.success) {
      const pending = {
        ...result,
        success: false,
        errorReason: "settlement_pending",
        errorMessage: `broadcast ${result.transaction} could not be confirmed (simulated)`,
      };
      heldPending.set(key, pending);
      return void res.json(pending);
    }
    res.json(result);
  } catch (e) {
    console.error("[settle error]", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "settle error" });
  }
});

app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));

// Local only: this service spends SOL on fees and has no login, so the gateway
// is the only thing that should reach it. Set FACILITATOR_HOST only if you add
// your own access control in front of it.
app.listen(PORT, process.env.FACILITATOR_HOST ?? "127.0.0.1", () => {
  console.log(`facilitator on http://localhost:${PORT} as ${account.address}`);
  // Scans the chain, which can be slow, so it mustn't hold up the service.
  recoverOpenChannels().catch((e) =>
    console.error("[recovery] failed:", e instanceof Error ? e.message : e),
  );
});

async function shutdown() {
  // Channel records are on disk, so cleanup can carry on after the next start.
  await Promise.race([
    Promise.allSettled([uptoCleanup.stop(), batchCleanup.stop()]),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
