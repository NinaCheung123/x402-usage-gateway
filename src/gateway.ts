/**
 * The gateway. Any registered seller gets, with no billing code of its own:
 *
 *   POST /s/:seller/generate        `upto`: one on-chain lock and settle per call.
 *                                   The chain enforces each call's ceiling.
 *   POST /s/:seller/batch/generate  `batch-settlement`: one deposit, many metered
 *                                   calls off-chain, claimed in batches.
 *
 * An agent with no account gets a 402 with the most a request could cost, pays,
 * and is charged only for priced usage.
 */
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { BatchChannelManager, BatchSvmScheme } from "@x402/svm/batch-settlement/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dashboardHtml } from "./dashboard.js";
import { BATCH_CHANNEL_TX, feeAssumptions, networkCostAtomic, PER_CALL_TX } from "./costs.js";
import { DurableChannelStore, DurableOperationStore, TransactionCounter } from "./durable.js";
import { Ledger, type Entry, type Scheme } from "./ledger.js";
import { DEMO_RATE_CARD, maxCharge, priceUsage } from "./pricing.js";
import { providerFor, ProviderError, requireText, type Failure } from "./provider.js";
import { SellerRegistry, validateSeller, type Seller } from "./sellers.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const PORT = Number(process.env.GATEWAY_PORT ?? 4021);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const DATA = process.env.DATA_DIR ?? "data";
const FAILURES: Failure[] = ["provider_error", "truncated", "overrun"];
const MINT = process.env.TEST_MINT!;
const RPC_URL = process.env.RPC_SHIELD_URL ?? process.env.SVM_RPC_URL!;
/** Ceiling for the refund route, which does no metered work. */
const CHANNEL_ROUTE_CEILING = "1000";

const keyOf = (name: string) =>
  createKeyPairSignerFromBytes(base58.decode(process.env[name]!.trim()));
const receiverAuthorizerSigner = await keyOf("RECEIVER_AUTHORIZER_KEY");
const operator = await keyOf("OPERATOR_KEY");

const ledger = new Ledger(process.env.LEDGER_PATH ?? `${DATA}/ledger.jsonl`);
const sellers = new SellerRegistry(`${DATA}/sellers.json`);

// The built-in demo seller, so the gateway works straight after setup.
if (!sellers.get("atlas")) {
  const payTo = (await keyOf("SELLER_KEY")).address;
  sellers.upsert({ id: "atlas", name: "Atlas AI (demo)", payTo, provider: { type: "simulated" }, rateCard: DEMO_RATE_CARD });
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const channelStore = new DurableChannelStore(`${DATA}/gateway-channels.json`);
const batchTransactions = new TransactionCounter(`${DATA}/batch-transactions.json`);
const batchScheme = new BatchSvmScheme({
  withdrawDelay: 900,
  receiverAuthorizer: receiverAuthorizerSigner,
  operator,
  store: channelStore,
  // Without this, a restart forgets used proofs and they can be charged again.
  operationStore: new DurableOperationStore(`${DATA}/gateway-operations.jsonl`),
});

const decodePayer = (header?: string): string | undefined => {
  if (!header) return undefined;
  try {
    const p = decodePaymentSignatureHeader(header).payload as Record<string, unknown> & {
      channelConfig?: { payer?: string };
      authorization?: { payer?: string };
    };
    return (p.from ?? p.payer ?? p.channelConfig?.payer ?? p.authorization?.payer) as string | undefined;
  } catch {
    return undefined;
  }
};
const proofOf = (req: Request) => req.header("payment-signature") ?? req.header("x-payment");
const hashProof = (proof: string) => createHash("sha256").update(proof).digest("hex");
const payerOf = (req: Request) => decodePayer(req.header("payment-signature") ?? req.header("x-payment"));
const sellerFromPath = (path: string) => {
  try {
    return sellers.get(decodeURIComponent(path.split("/")[2] ?? ""));
  } catch {
    return undefined;
  }
};

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new UptoSvmScheme({ receiverAuthorizerSigner, rpcUrl: RPC_URL }))
  .register(NETWORK, batchScheme);
await resourceServer.initialize();

/**
 * Each wallet needs a worker to claim its vouchers before they can be lost. x402's
 * worker redeems every channel in the store it's given, so each one gets a view
 * limited to its own wallet. Sellers sharing a wallet share a worker.
 */
const managers = new Map<string, BatchChannelManager>();
const recentClaims: { at: string; payTo: string; kind: string; tx: string; vouchers?: number }[] = [];
async function startRedemption(seller: Seller) {
  const { payTo } = seller;
  if (managers.has(payTo)) return;
  const kind = (await facilitatorClient.getSupported()).kinds.find(
    (k) => k.scheme === "batch-settlement" && k.network === NETWORK,
  );
  if (!kind) return void console.warn("facilitator doesn't offer batch-settlement");
  const terms = await batchScheme.enhancePaymentRequirements(
    { scheme: "batch-settlement", network: NETWORK, amount: CHANNEL_ROUTE_CEILING, asset: MINT, payTo, maxTimeoutSeconds: 300, extra: {} },
    kind,
    [],
  );
  const note = (kindName: string, tx: string, vouchers?: number) => {
    recentClaims.unshift({ at: new Date().toISOString(), payTo, kind: kindName, tx, vouchers });
    recentClaims.length = Math.min(recentClaims.length, 30);
    batchTransactions.add(payTo);
    console.log(`[redeem ${payTo.slice(0, 6)}] ${kindName} ${vouchers ?? ""} tx=${tx}`);
  };
  // Built directly: createChannelManager always uses the whole store.
  const manager = new BatchChannelManager({
    store: channelStore.forReceiver(payTo),
    requirements: terms,
    receiverAuthorizer: receiverAuthorizerSigner,
    settle: (payload, accepted) => facilitatorClient.settle(payload as never, accepted),
    rpcUrl: RPC_URL,
    onClaim: (r) => note("claim", r.transaction, r.vouchers),
    onSettle: (r) => note("distribute", r.transaction),
    onError: (e) => console.error(`[redeem ${payTo.slice(0, 6)}]`, e instanceof Error ? e.message : e),
  });
  manager.start(Number(process.env.REDEEM_INTERVAL_SECS ?? 20));
  managers.set(payTo, manager);
}
for (const s of sellers.all()) await startRedemption(s);

interface GenerateBody {
  model: string;
  prompt: string;
  max_output_tokens: number;
  simulate_failure?: Failure;
}

/** Returns an error message, or null if the body is valid for this seller. */
function validate(seller: Seller, body: Partial<GenerateBody> | undefined): string | null {
  const models = seller.rateCard.models;
  const model = body?.model;
  if (!body || typeof model !== "string" || !Object.hasOwn(models, model))
    return `model must be one of: ${Object.keys(models).join(", ")}`;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "prompt is required";
  const max = body.max_output_tokens;
  if (!Number.isInteger(max) || max! < 1 || max! > models[model]!.maxOutputTokens)
    return `max_output_tokens must be 1 to ${models[model]!.maxOutputTokens}`;
  if (body.simulate_failure) {
    // Off unless the demo turns it on: an overrun costs the seller real money.
    if (process.env.ALLOW_SIMULATED_FAILURES !== "true") return "simulate_failure is not enabled here";
    if (seller.provider.type !== "simulated") return "simulate_failure needs a simulated provider";
    if (!FAILURES.includes(body.simulate_failure))
      return `simulate_failure must be one of: ${FAILURES.join(", ")}`;
  }
  return null;
}

const app = express();
app.use(express.json({ limit: "100kb" }));

const requireSeller = (req: Request, res: Response, next: NextFunction) => {
  const seller = sellers.get(String(req.params.seller));
  if (!seller) return void res.status(404).json({ error: "unknown_seller", message: "No such seller." });
  res.locals.seller = seller;
  next();
};

// Reject bad requests before the 402, so nobody locks funds for a doomed call.
const requireValidBody = (req: Request, res: Response, next: NextFunction) => {
  const error = validate(res.locals.seller as Seller, req.body as Partial<GenerateBody>);
  if (error) return void res.status(400).json({ error: "invalid_request", message: error });
  next();
};

/** Turns x402's internal failure codes into something an agent can act on. */
function explainPaymentFailure(reason?: string) {
  switch (reason) {
    case "invalid_upto_svm_channel_already_open":
    case "duplicate_settlement":
      return {
        error: "payment_proof_reused",
        message: "This payment proof was already used, so you weren't charged again. If you lost the answer, POST this proof to /v1/recover. Otherwise request a new 402 and pay again.",
      };
    case "invalid_upto_svm_settlement_simulation":
    case "invalid_batch_settlement_svm_settlement_simulation":
      return {
        error: "payment_not_locked",
        message: "The funds could not be locked, usually because the wallet holds too little. No money moved and no work started. Lower max_output_tokens, choose a cheaper model, or add funds.",
      };
    case "No matching payment requirements":
      return {
        error: "payment_does_not_match",
        message: "This payment doesn't match this request's price. Request a new 402 and pay again.",
      };
    case "settlement_pending":
      return {
        error: "payment_unconfirmed",
        message: "The payment was sent but not confirmed yet. Don't pay again: check the receipt.",
      };
    default:
      return { error: "payment_failed", message: `The payment failed (${reason ?? "unknown reason"}).` };
  }
}

const readSettlement = (raw: unknown) => {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString()) as {
      success: boolean;
      transaction?: string;
      errorReason?: string;
      errorMessage?: string;
    };
  } catch {
    return undefined;
  }
};

/** x402 reports some refusals only in the response body, as { error: reason }. */
const reasonFromBody = (chunk: unknown) => {
  try {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
    const error = (JSON.parse(text) as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
};

/** Records a paid call's result. The agent may already have hung up. */
function recordCallResult(res: Response, id: string, s: ReturnType<typeof readSettlement>) {
  const entry = ledger.get(id);
  if (!s) return; // Nothing settled yet. Reconciliation deals with it if this persists.
  if (entry?.status === "refunded") {
    const change = s.success
      ? { tx: s.transaction || undefined }
      : { status: "refund_pending" as const, reason: `${entry.reason ?? "Provider failed"}. Refund failed; channel cleanup returns the funds.` };
    return void ledger.update(id, change);
  }
  if (s.success) {
    const status = res.locals.scheme === "batch-settlement" ? "metered" : "settled";
    return void ledger.update(id, { status, tx: s.transaction || undefined });
  }
  // Sent but unconfirmed isn't failed: keep it pending, hold the answer, ask the chain.
  if (s.errorReason === "settlement_pending" && s.transaction) {
    return void ledger.update(id, {
      status: "pending",
      tx: s.transaction,
      reason: "Sent, awaiting confirmation",
    });
  }
  // Nothing was charged, so the answer must not be collectable for free.
  ledger.update(id, { status: "settle_failed", reason: s.errorMessage ?? s.errorReason ?? "settlement failed", answer: undefined });
}

/**
 * Records what happened to each payment and explains failures. This runs when
 * x402 finishes the response, after settlement, rather than when the response
 * reaches the agent, so an agent hanging up can't hide a real charge.
 */
const trackPayment = (req: Request, res: Response, next: NextFunction) => {
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  let done = false;
  res.end = ((...args: unknown[]) => {
    if (done) return end(...args);
    done = true;
    const s = readSettlement(res.getHeader("payment-response"));
    const id = res.locals.entryId as string | undefined;
    if (id) recordCallResult(res, id, s);

    const refused = res.statusCode === 402 && (s ? !s.success : !!req.header("payment-signature"));
    const reason = refused ? (s?.errorReason ?? reasonFromBody(args[0])) : undefined;
    // A proof x402 can't even read gets the ordinary 402, and isn't worth a record.
    if (!refused || !reason || reason === "Payment required") return end(...args);

    const explained = explainPaymentFailure(reason);
    if (!id) {
      // Funds were never locked, or the lock wasn't confirmed: no work ran.
      ledger.put({
        id: randomUUID(),
        at: new Date().toISOString(),
        status: reason === "settlement_pending" ? "settle_failed" : "rejected",
        sellerId: (res.locals.seller as Seller | undefined)?.id,
        scheme: res.locals.scheme as Scheme,
        payer: payerOf(req),
        chargeAtomic: "0",
        providerCostAtomic: "0",
        tx: s?.transaction || undefined,
        reason: explained.message,
      });
    }
    const body = JSON.stringify({
      ...explained,
      // An unconfirmed payment may still land, so the answer stays collectable.
      ...(id ? { receipt_url: `/v1/receipts/${id}`, answer_url: `/v1/receipts/${id}/answer` } : {}),
    });
    if (res.headersSent) return end(...args);
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", Buffer.byteLength(body));
    return end(body);
  }) as typeof res.end;
  next();
};

/** A Solana transaction's blockhash expires in minutes, so this is long enough. */
const PENDING_LIMIT_MS = 5 * 60 * 1000;
const ANSWER_RETENTION_MS = Number(process.env.ANSWER_RETENTION_HOURS ?? 24) * 60 * 60 * 1000;

/** Resolve pending entries from the chain, so the ledger matches reality. */
async function reconcilePending() {
  ledger.forgetAnswersBefore(Date.now() - ANSWER_RETENTION_MS);
  const open = ledger.all().filter((e) => e.status === "pending");
  const isOld = (e: Entry) => Date.now() - Date.parse(e.at) > PENDING_LIMIT_MS;
  // No transaction means the outcome was lost, for example in a crash. The
  // ledger can't know whether money moved, so it says so rather than guessing.
  for (const e of open) {
    if (!e.tx && isOld(e))
      ledger.update(e.id, { status: "needs_review", reason: "Outcome lost, possibly a crash mid-call. Check the seller's wallet." });
  }
  const pending = open.filter((e) => e.tx);
  if (!pending.length) return;
  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [pending.map((e) => e.tx), { searchTransactionHistory: true }],
      }),
    });
    const { result } = (await r.json()) as {
      result: { value: ({ confirmationStatus?: string; err: unknown } | null)[] };
    };
    result.value.forEach((status, i) => {
      const entry = pending[i]!;
      if (!status) {
        // It never landed and now can't, so stop holding the answer and say so.
        if (isOld(entry)) ledger.update(entry.id, { status: "settle_failed", reason: "Settlement never landed", answer: undefined });
        return;
      }
      if (status.err) {
        // No charge landed, so the held answer must not be released for free.
        ledger.update(entry.id, { status: "settle_failed", reason: "Settlement failed on-chain", answer: undefined });
      } else if (status.confirmationStatus !== "processed") {
        ledger.update(entry.id, { status: "settled", reason: undefined });
      }
    });
  } catch (e) {
    console.error("[reconcile]", e instanceof Error ? e.message : e);
  }
}
setInterval(() => void reconcilePending(), Number(process.env.RECONCILE_INTERVAL_SECS ?? 10) * 1000);

const priceFromBody = (ctx: { path: string; adapter: { getBody?(): unknown } }) => {
  const seller = sellerFromPath(ctx.path)!;
  const body = ctx.adapter.getBody?.() as GenerateBody;
  return { amount: maxCharge(seller.rateCard, body.model, body.prompt, body.max_output_tokens).toString(), asset: MINT, extra: {} };
};
const payToFromPath = (ctx: { path: string }) => sellerFromPath(ctx.path)!.payTo;

/**
 * Batch callers: ask for about 20 calls' worth up front. x402's default is 3,
 * which forces an on-chain top-up every few calls and defeats batching. The
 * agent's own deposit cap still limits this, and what's unused comes back.
 */
const DEPOSIT_CALLS = 20n;
const batchPriceFromBody = (ctx: { path: string; adapter: { getBody?(): unknown } }) => {
  const price = priceFromBody(ctx);
  return { ...price, extra: { minDeposit: (BigInt(price.amount) * DEPOSIT_CALLS).toString() } };
};

const payment = paymentMiddleware(
  {
    // Listed first: "*" spans slashes, so the per-call pattern below also matches this path.
    "POST /s/*/batch/generate": {
      accepts: { scheme: "batch-settlement", price: batchPriceFromBody, network: NETWORK, payTo: payToFromPath, maxTimeoutSeconds: 300 },
      description: "AI generation for repeat callers: one deposit, metered calls",
      mimeType: "application/json",
    },
    "POST /s/*/generate": {
      accepts: { scheme: "upto", price: priceFromBody, network: NETWORK, payTo: payToFromPath, maxTimeoutSeconds: 120 },
      description: "AI generation, charged by actual usage",
      mimeType: "application/json",
    },
    // The route an agent's x402 client probes to close its channel and get a refund.
    "GET /s/*/channel": {
      accepts: {
        scheme: "batch-settlement",
        price: { amount: CHANNEL_ROUTE_CEILING, asset: MINT, extra: {} },
        network: NETWORK,
        payTo: payToFromPath,
        maxTimeoutSeconds: 300,
      },
      description: "Batch channel management",
      mimeType: "application/json",
    },
  },
  resourceServer,
  undefined,
  undefined,
  false,
);

const generate = (scheme: Scheme) => async (req: Request, res: Response) => {
  const seller = res.locals.seller as Seller;
  const body = req.body as GenerateBody;
  const card = seller.rateCard;
  const at = new Date();
  const id = randomUUID();
  const payer = payerOf(req);
  const authorized = maxCharge(card, body.model, body.prompt, body.max_output_tokens);
  res.locals.entryId = id;

  const base: Entry = {
    id,
    at: at.toISOString(),
    status: "pending",
    sellerId: seller.id,
    scheme,
    payer,
    model: body.model,
    authorizedAtomic: authorized.toString(),
    chargeAtomic: "0",
    providerCostAtomic: "0",
  };

  try {
    const out = requireText(
      await providerFor(seller.provider).generate({
        model: card.models[body.model]!.upstreamModel ?? body.model,
        prompt: body.prompt,
        maxOutputTokens: body.max_output_tokens,
        failure: body.simulate_failure,
      }),
    );
    const price = priceUsage(card, body.model, out.usage, {
      at,
      tokensBilled: payer ? ledger.tokensBilled(seller.id, payer) : 0,
    });
    // Payment can't settle above the ceiling, so the seller absorbs any overrun.
    const charge = price.chargeAtomic > authorized ? authorized : price.chargeAtomic;
    const unbilled = price.chargeAtomic - charge;

    const answer = {
      text: out.text,
      usage_record: {
        id,
        seller: seller.id,
        scheme,
        model: body.model,
        delivered: out.delivered,
        tokens: out.usage,
        tier: price.tier,
        period: price.period,
        lines: price.lines,
        authorized_atomic: authorized.toString(),
        charged_atomic: charge.toString(),
        // Per call, the rest really goes back. In a batch, it just stays in the deposit.
        ...(scheme === "upto"
          ? { returned_atomic: (authorized - charge).toString() }
          : { unspent_authorization_atomic: (authorized - charge).toString() }),
        receipt_url: `/v1/receipts/${id}`,
      },
    };
    const proof = proofOf(req);
    ledger.put({
      ...base,
      usage: out.usage,
      tier: price.tier,
      period: price.period,
      lines: price.lines,
      chargeAtomic: charge.toString(),
      providerCostAtomic: price.providerCostAtomic.toString(),
      delivered: out.delivered,
      answer,
      ...(proof ? { proofHash: hashProof(proof) } : {}),
      ...(unbilled > 0n ? { unbilledAtomic: unbilled.toString() } : {}),
    });
    setSettlementOverrides(res, { amount: charge.toString() });
    res.json(answer);
  } catch (e) {
    // Any status of 400 or above cancels settlement, so the caller isn't charged.
    const wasted = e instanceof ProviderError ? e.usage : undefined;
    ledger.put({
      ...base,
      status: "refunded",
      delivered: "none",
      // The provider may still have billed the seller for an answer with no text.
      ...(wasted
        ? { usage: wasted, providerCostAtomic: priceUsage(card, body.model, wasted, { at, tokensBilled: 0 }).providerCostAtomic.toString() }
        : {}),
      reason: e instanceof Error ? e.message : "provider error",
    });
    res.status(e instanceof ProviderError ? 502 : 500).json({
      error: "provider_failed",
      message: "The AI provider failed. You were not charged.",
      usage_record: { id, charged_atomic: "0", receipt_url: `/v1/receipts/${id}` },
    });
  }
};

const mount = (scheme: Scheme) => {
  const setScheme = (_req: Request, res: Response, next: NextFunction) => {
    res.locals.scheme = scheme;
    next();
  };
  return [requireSeller, setScheme, requireValidBody, trackPayment, payment, generate(scheme)];
};
app.post("/s/:seller/generate", ...mount("upto"));
app.post("/s/:seller/batch/generate", ...mount("batch-settlement"));
app.get("/s/:seller/channel", requireSeller, payment, (_req, res) => res.json({ ok: true }));

/** Free: what a call could cost, so an agent can choose before locking funds. */
app.post("/s/:seller/quote", requireSeller, requireValidBody, (req, res) => {
  const body = req.body as GenerateBody;
  res.json({
    seller: (res.locals.seller as Seller).id,
    model: body.model,
    max_authorized_atomic: maxCharge((res.locals.seller as Seller).rateCard, body.model, body.prompt, body.max_output_tokens).toString(),
    note: "This is the ceiling. You are charged for actual usage only.",
  });
});

app.get("/s/:seller/pricing", requireSeller, (_req, res) => {
  const s = res.locals.seller as Seller;
  const models = Object.fromEntries(
    Object.entries(s.rateCard.models).map(([id, m]) => [
      id,
      { input: m.input, cached_input: m.cachedInput, output: m.output, max_output_tokens: m.maxOutputTokens },
    ]),
  );
  res.json({
    seller: s.id,
    name: s.name,
    token_decimals: 6,
    unit: "atomic units per 1M AI tokens",
    models,
    peak: s.rateCard.peak,
    tiers: s.rateCard.tiers,
    min_charge_atomic: s.rateCard.minChargeAtomic,
    operator: operator.address,
  });
});

const publicEntry = ({ answer: _answer, proofHash: _proofHash, ...e }: Entry) => e;

app.get("/v1/receipts/:id", (req, res) => {
  const entry = ledger.get(req.params.id);
  if (!entry) return void res.status(404).json({ error: "not_found" });
  res.json(publicEntry(entry));
});

const isPaid = (e: Entry) => e.status === "settled" || e.status === "metered";

function sendAnswer(res: Response, entry: Entry | undefined) {
  if (!entry) return void res.status(404).json({ error: "not_found" });
  if (entry.status === "pending")
    return void res.status(202).json({ status: "pending", message: "Still waiting for the chain. Try again shortly." });
  if (isPaid(entry) && entry.answer) return void res.json(entry.answer);
  res.status(410).json({ status: entry.status, message: "No answer is held for this receipt. It may have expired, or no charge landed." });
}

/** Collect an answer by receipt. The id is unguessable and only the caller was given it. */
app.get("/v1/receipts/:id/answer", (req, res) => sendAnswer(res, ledger.get(req.params.id)));

/**
 * Collect an answer after losing the response, when the caller has no receipt.
 * The proof is the caller's own signature, which only it and the gateway hold.
 * This never runs the model or charges anything.
 */
app.post("/v1/recover", (req, res) => {
  const proof = proofOf(req);
  if (!proof) return void res.status(400).json({ error: "invalid_request", message: "Send the payment proof in the payment-signature header." });
  sendAnswer(res, ledger.findByProof(hashProof(proof)));
});

const isLoopback = (req: Request) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

function hasAdminToken(req: Request) {
  const expected = Buffer.from(`Bearer ${process.env.ADMIN_TOKEN ?? ""}`);
  const given = Buffer.from(req.header("authorization") ?? "");
  return !!process.env.ADMIN_TOKEN && given.length === expected.length && timingSafeEqual(given, expected);
}

/** Seller data is private. The dashboard works from this machine or with the token. */
const requireLocalOrAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (isLoopback(req) || hasAdminToken(req)) return next();
  res.status(401).json({ error: "unauthorized" });
};

/** Onboard a seller: wallet, rate card and model source. Calling again updates it. */
app.post("/admin/sellers", async (req, res) => {
  if (!hasAdminToken(req)) return void res.status(401).json({ error: "unauthorized" });
  const body = req.body as Partial<Seller>;
  const error = validateSeller(body);
  if (error) return void res.status(400).json({ error: "invalid_seller", message: error });
  // Settlement fails later if the wallet can't hold this token, so check now.
  const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(body.payTo!)).toBase58();
  const check = (await (
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [tokenAccount, { encoding: "base64" }] }),
    })
  ).json()) as { result?: { value: unknown } };
  if (!check.result?.value) {
    return void res.status(400).json({
      error: "wallet_not_ready",
      message: `Wallet ${body.payTo} has no token account for ${MINT}. Create it, then register again.`,
    });
  }
  const seller = sellers.upsert({
    id: body.id!,
    name: body.name!,
    payTo: body.payTo!,
    provider: body.provider!,
    rateCard: body.rateCard!,
  });
  await startRedemption(seller);
  res.status(201).json({
    seller: seller.id,
    endpoints: {
      pay_per_call: `/s/${seller.id}/generate`,
      repeat_callers: `/s/${seller.id}/batch/generate`,
      quote: `/s/${seller.id}/quote`,
      pricing: `/s/${seller.id}/pricing`,
    },
  });
});

async function walletBalance(payTo: string) {
  const account = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(payTo)).toBase58();
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [account] }),
  });
  const { result } = (await r.json()) as { result?: { value: { amount: string } } };
  return result?.value.amount ?? "0";
}

app.get("/api/sellers", requireLocalOrAdmin, (_req, res) => {
  res.json(sellers.all().map((s) => ({ id: s.id, name: s.name, payTo: s.payTo, provider: s.provider.type })));
});

app.get("/api/stats", requireLocalOrAdmin, async (req, res) => {
  const requested = String(req.query.seller ?? "");
  const seller = sellers.get(requested);
  // An unknown id must not fall through to everyone's numbers.
  if (requested && !seller) return void res.status(404).json({ error: "unknown_seller" });
  const recent = ledger.all().filter((e) => !seller || e.sellerId === seller.id).slice(0, 30).map(publicEntry);
  const channels = await channelStore.list();
  const unclaimed = channels
    .filter((c) => !seller || c.receiver === seller.payTo)
    .reduce((t, c) => t + (c.signedMaxClaimable > c.settled ? c.signedMaxClaimable - c.settled : 0n), 0n);
  const stats = ledger.stats(seller?.id);
  // Batch transactions belong to a wallet, so sellers sharing one share this count.
  const walletChannels = channels.filter((c) => !seller || c.receiver === seller.payTo);
  const batchTx = walletChannels.length * BATCH_CHANNEL_TX + (seller ? batchTransactions.get(seller.payTo) : batchTransactions.total());
  const perCallTx = ledger.perCallsOnChain(seller?.id) * PER_CALL_TX;
  const assumptions = feeAssumptions();
  const perCallFee = networkCostAtomic(perCallTx, assumptions);
  const batchFee = networkCostAtomic(batchTx, assumptions);
  const fees = perCallFee + batchFee;
  res.json({
    ...stats,
    network: {
      assumptions,
      feesAtomic: fees.toString(),
      marginAfterModelAndNetworkAtomic: (BigInt(stats.marginAtomic) - fees).toString(),
      upto: { transactions: perCallTx, feesAtomic: perCallFee.toString() },
      "batch-settlement": { transactions: batchTx, channels: walletChannels.length, feesAtomic: batchFee.toString() },
    },
    unclaimedAtomic: unclaimed.toString(),
    walletAtomic: seller ? await walletBalance(seller.payTo).catch(() => null) : null,
    recent,
    claims: recentClaims.filter((c) => !seller || c.payTo === seller.payTo).slice(0, 10),
  });
});

app.get("/", requireLocalOrAdmin, (_req, res) => res.type("html").send(dashboardHtml()));

// Local by default, because the dashboard trusts this machine. To serve agents
// directly, set GATEWAY_HOST. Behind a reverse proxy every caller looks local,
// so the dashboard check needs changing first.
app.listen(PORT, process.env.GATEWAY_HOST ?? "127.0.0.1", () => {
  console.log(`gateway on http://localhost:${PORT}  (dashboard at /)`);
  console.log(`sellers: ${sellers.all().map((s) => s.id).join(", ")}  operator ${operator.address}  token ${MINT}`);
});

async function shutdown() {
  // Try to claim what's owed before stopping, but don't hang on a slow or missing
  // facilitator: unclaimed vouchers are on disk, so the next start claims them.
  await Promise.race([
    Promise.allSettled([...managers.values()].map((m) => m.stop({ flush: true }))),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
