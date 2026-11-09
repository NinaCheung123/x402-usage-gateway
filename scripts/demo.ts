/**
 * End-to-end demo and test. A paying agent runs each scenario against the live
 * gateway on Solana devnet, and every money claim is checked against on-chain
 * balances, not against what the gateway says. Exits 1 if any check fails.
 */
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { x402Client } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { DEMO_RATE_CARD } from "../src/pricing.js";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4021";
const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const RPC = process.env.RPC_SHIELD_URL ?? "http://localhost:8899";
const MINT = new PublicKey(process.env.TEST_MINT!);
const conn = new Connection(RPC, "confirmed");

const keyOf = (name: string) => createKeyPairSignerFromBytes(base58.decode(process.env[name]!.trim()));
const agent = await keyOf("AGENT_KEY");
const atlasWallet = (await keyOf("SELLER_KEY")).address;
const novaWallet = (await keyOf("SELLER2_KEY")).address;
const facilitatorWallet = (await keyOf("FACILITATOR_KEY")).address;
const operator = (await keyOf("OPERATOR_KEY")).address;

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
const title = (s: string) => console.log(`\n── ${s}`);
const tokens = (a: bigint | string) => (Number(a) / 1e6).toFixed(6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const balance = async (owner: string) => {
  try {
    return (await getAccount(conn, getAssociatedTokenAddressSync(MINT, new PublicKey(owner)))).amount;
  } catch {
    return 0n;
  }
};
const balances = async () => ({ agent: await balance(agent.address), atlas: await balance(atlasWallet), nova: await balance(novaWallet) });
type Balances = Awaited<ReturnType<typeof balances>>;

/** Wait until the chain shows the expected moves, or report what it does show. */
async function waitFor(ok: (now: Balances) => boolean, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const now = await balances();
    if (ok(now) || Date.now() > deadline) return now;
    await sleep(2000);
  }
}
const settledTo = (b: Balances, charge: bigint, wallet: "atlas" | "nova" = "atlas") =>
  waitFor((n) => b.agent - n.agent === charge && n[wallet] - b[wallet] === charge);

/** The agent's x402 client: per-call payments, with a limit it enforces itself. */
function perCallClient(signer: TransactionSigner, capAtomic = "1000000") {
  const proofs: string[] = [];
  const recording: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const proof = req.headers.get("payment-signature");
    if (proof) proofs.push(proof);
    return fetch(req);
  };
  const client = new x402Client()
    .register("solana:*", new UptoSvmScheme(signer, { rpcUrl: RPC } as never))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxAmountPerPayment: capAtomic }] });
  return { pay: wrapFetchWithPayment(recording, client), proofs };
}

/**
 * Repeat calls: one deposit. The operator signs each metered charge, so the
 * agent chooses which operators to trust and caps what it deposits with them.
 */
function batchClient(signer: KeyPairSigner, trusted: string[], maxDeposit = "200000") {
  const scheme = new BatchSvmScheme(signer, {
    rpcUrl: RPC,
    serverSignedChannelsPolicy: {
      allowedOperators: trusted,
      allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxDeposit }],
    },
  } as never);
  const client = new x402Client()
    .register("solana:*", scheme)
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxAmountPerPayment: "1000000" }] });
  const proofs: string[] = [];
  const race = { armed: false, statuses: [] as number[] };
  const recording: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const proof = req.headers.get("payment-signature");
    if (proof) proofs.push(proof);
    if (proof && race.armed) {
      // Send the same paid request twice at once, as a retrying client might.
      race.armed = false;
      const both = await Promise.all([fetch(req.clone()), fetch(req.clone())]);
      race.statuses = both.map((r) => r.status);
      return both.find((r) => r.status === 200) ?? both[0]!;
    }
    return fetch(req);
  };
  return { scheme, proofs, race, pay: wrapFetchWithPayment(recording, client) };
}

const post = (path: string, body: unknown, f: typeof fetch = fetch, headers: Record<string, string> = {}) =>
  f(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const getJson = async <T>(path: string) => (await (await fetch(`${GATEWAY}${path}`)).json()) as T;

interface UsageRecord {
  id: string;
  charged_atomic: string;
  authorized_atomic: string;
  returned_atomic: string;
  tier: string;
  period: string;
  delivered: string;
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  lines: { type: string; tokens: number; amount: string }[];
}

/** Reads the usage record, or stops with the gateway's reason for not giving one. */
async function usageOf(r: Response) {
  if (r.status === 200) return ((await r.json()) as { usage_record: UsageRecord }).usage_record;
  throw new Error(`expected 200, got ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

const { pay, proofs } = perCallClient(agent);
const runId = Date.now().toString(36); // Fresh prompts, so the first call isn't cached.
const prompt = `[${runId}] Summarize why usage-based pricing suits AI agents.`;
const ADMIN = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

// The demo causes failures on purpose, which normal mode rightly refuses.
{
  const probe = await post("/s/atlas/quote", { model: "atlas-fast", prompt: "x", max_output_tokens: 1, simulate_failure: "truncated" }).catch(() => undefined);
  if (probe?.status !== 200) {
    console.error(probe ? "The demo needs its failure switches. Stop `npm start` and run `npm run start:demo`." : "Nothing is running. Start it with `npm run start:demo` in another terminal.");
    process.exit(1);
  }
}

// ────────────────────────────── Paying per call ──────────────────────────────

title("1. Invalid request: rejected before anyone locks money");
{
  const r = await post("/s/atlas/generate", { model: "not-a-model", prompt, max_output_tokens: 100 });
  check("returns 400, not 402", r.status === 400, `status ${r.status}`);
  const u = await post("/s/nobody/generate", { model: "x", prompt, max_output_tokens: 100 });
  check("unknown seller returns 404", u.status === 404, `status ${u.status}`);
}

title("2. No payment: 402 says the most this call could cost");
{
  const before = await balances();
  const r = await post("/s/atlas/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 });
  const quote = (await (await post("/s/atlas/quote", { model: "atlas-fast", prompt, max_output_tokens: 300 })).json()) as { max_authorized_atomic: string };
  check("returns 402", r.status === 402, `status ${r.status}`);
  console.log(`   ceiling from the quote: ${tokens(quote.max_authorized_atomic)} tokens`);
  const after = await balances();
  check("no money moved", before.agent === after.agent && before.atlas === after.atlas);
  const tricks = ["/S/atlas/generate", "/s/atlas/GENERATE", "/s/atlas/generate/", "/s/atlas//generate", "/s/at%6Cas/generate", "/s/atlas/gener%61te", "/s/atlas/BATCH/generate", "/s/atlas/batch/generate/"];
  const codes = await Promise.all(tricks.map(async (t) => (await post(t, { model: "atlas-fast", prompt, max_output_tokens: 300 })).status));
  check("rewritten paths never get a free answer", codes.every((c) => c !== 200 && c !== 500), codes.join(" "));
}

title("3. Normal call: charged for actual usage, rest returned");
let firstCharge = 0n;
{
  const before = await balances();
  const t0 = Date.now();
  const r = await post("/s/atlas/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, pay);
  const ms = Date.now() - t0;
  const u = await usageOf(r);
  firstCharge = BigInt(u.charged_atomic);
  const after = await settledTo(before, firstCharge);
  console.log(`   ${ms} ms. locked ${tokens(u.authorized_atomic)}, charged ${tokens(u.charged_atomic)}, returned ${tokens(u.returned_atomic)}  [${u.tier}, ${u.period}]`);
  for (const l of u.lines) if (l.tokens) console.log(`     ${l.type}: ${l.tokens} AI tokens = ${l.amount} tokens`);
  check("charge is below the ceiling", firstCharge < BigInt(u.authorized_atomic));
  check("on-chain: agent paid exactly the charge", before.agent - after.agent === firstCharge, tokens(before.agent - after.agent));
  check("on-chain: seller received exactly the charge", after.atlas - before.atlas === firstCharge, tokens(after.atlas - before.atlas));
  const receipt = await getJson<{ status: string; tx?: string }>(`/v1/receipts/${u.id}`);
  check("receipt shows settled with a transaction", receipt.status === "settled" && !!receipt.tx, receipt.tx?.slice(0, 16));
}

title("3b. Agent hangs up mid-call: the charge is still recorded");
{
  let hungUpProof = "";
  const hangUp: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const proof = req.headers.get("payment-signature");
    if (!proof) return fetch(req);
    hungUpProof = proof;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    return fetch(req, { signal: stop.signal });
  };
  const client = new x402Client()
    .register("solana:*", new UptoSvmScheme(agent, { rpcUrl: RPC } as never))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxAmountPerPayment: "1000000" }] });
  const before = await balances();
  const marker = `${prompt} hangup`;
  await wrapFetchWithPayment(hangUp, client)(`${GATEWAY}/s/atlas/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "atlas-fast", prompt: marker, max_output_tokens: 300 }),
  }).catch(() => undefined);
  const after = await waitFor((n) => n.atlas > before.atlas && before.agent - n.agent === n.atlas - before.atlas);
  const onChain = after.atlas - before.atlas;
  // The chain can show the money before the facilitator has finished confirming it.
  let recent: { status: string; chargeAtomic: string }[] = [];
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(2000)) {
    ({ recent } = await getJson<{ recent: typeof recent }>("/api/stats?seller=atlas"));
    if (recent[0]?.status !== "pending") break;
  }
  check("on-chain: the charge landed", onChain > 0n, tokens(onChain));
  check("ledger shows it as settled for the same amount", recent[0]?.status === "settled" && BigInt(recent[0].chargeAtomic) === onChain, recent[0]?.status);
  const recovered = await fetch(`${GATEWAY}/v1/recover`, { method: "POST", headers: { "payment-signature": hungUpProof } });
  const recoveredBody = (await recovered.json()) as { text?: string };
  check("agent recovers the lost answer with its proof", recovered.status === 200 && !!recoveredBody.text, `status ${recovered.status}`);
  await sleep(3000);
  const later = await balances();
  check("on-chain: recovering it cost nothing", later.agent === after.agent && later.atlas === after.atlas);
}

title("4. Same prompt again: cached input costs less");
{
  const before = await balances();
  const u = await usageOf(await post("/s/atlas/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, pay));
  const charge = BigInt(u.charged_atomic);
  const after = await settledTo(before, charge);
  check("some input was cached", u.tokens.cachedInputTokens > 0, `${u.tokens.cachedInputTokens} cached`);
  check("cheaper than the first call", charge < firstCharge, `${tokens(charge)} vs ${tokens(firstCharge)}`);
  check("on-chain: agent paid exactly the charge", before.agent - after.agent === charge);
}

title("5. AI provider fails after funds are locked: full refund");
{
  const before = await balances();
  const r = await post("/s/atlas/generate", { model: "atlas-pro", prompt, max_output_tokens: 500, simulate_failure: "provider_error" }, pay);
  const b = (await r.json()) as { message: string; usage_record: { id: string } };
  console.log(`   agent sees: "${b.message}"`);
  check("returns 502", r.status === 502, `status ${r.status}`);
  const after = await settledTo(before, 0n);
  check("on-chain: agent lost nothing", after.agent === before.agent);
  check("on-chain: seller received nothing", after.atlas === before.atlas);
  const receipt = await getJson<{ status: string }>(`/v1/receipts/${b.usage_record.id}`);
  check("ledger says refunded", receipt.status === "refunded", receipt.status);
}

title("6. Answer cut off: charged only for what was delivered");
{
  const full = await usageOf(await post("/s/atlas/generate", { model: "atlas-fast", prompt: `${prompt} full`, max_output_tokens: 300 }, pay));
  await sleep(3000);
  const before = await balances();
  const u = await usageOf(await post("/s/atlas/generate", { model: "atlas-fast", prompt: `${prompt} tail`, max_output_tokens: 300, simulate_failure: "truncated" }, pay));
  const charge = BigInt(u.charged_atomic);
  const after = await settledTo(before, charge);
  check("marked as truncated", u.delivered === "truncated", u.delivered);
  check("cheaper than the full answer", charge < BigInt(full.charged_atomic), `${tokens(charge)} vs ${tokens(full.charged_atomic)}`);
  check("on-chain: agent paid exactly the charge", before.agent - after.agent === charge);
}

title("7. Provider returns too much: the charge stops at the ceiling");
{
  const before = await balances();
  const u = await usageOf(await post("/s/atlas/generate", { model: "atlas-pro", prompt: `${prompt} long`, max_output_tokens: 100, simulate_failure: "overrun" }, pay));
  const charge = BigInt(u.charged_atomic);
  const after = await settledTo(before, charge);
  check("charge equals the ceiling", charge === BigInt(u.authorized_atomic), tokens(charge));
  check("on-chain: agent paid no more than the ceiling", before.agent - after.agent === charge);
  const receipt = await getJson<{ unbilledAtomic?: string }>(`/v1/receipts/${u.id}`);
  check("ledger records the seller's unbilled loss", BigInt(receipt.unbilledAtomic ?? "0") > 0n, tokens(receipt.unbilledAtomic ?? "0"));
}

title("8. Reused payment proof: rejected");
{
  const before = await balances();
  const workDone = async () => {
    const { counts } = await getJson<{ counts: Record<string, number> }>("/api/stats");
    return Object.entries(counts).reduce((n, [status, c]) => (status === "rejected" ? n : n + c), 0);
  };
  const workBefore = await workDone();
  const r = await post("/s/atlas/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, fetch, { "payment-signature": proofs[0]! });
  const text = await r.text();
  await sleep(500);
  check("the AI model never ran", (await workDone()) === workBefore);
  console.log(`   agent sees: ${text.slice(0, 160)}`);
  check("no answer returned", r.status !== 200 && !text.includes("simulated answer"), `status ${r.status}`);
  check("error names the reused proof", text.includes("payment_proof_reused"));
  const after = await balances();
  check("no money moved", after.agent === before.agent && after.atlas === before.atlas);
}

title("9. Agent has no funds: clear error, no work");
{
  const { pay: brokePay } = perCallClient(await generateKeyPairSigner());
  const sellerBefore = await balance(atlasWallet);
  let outcome = "";
  let status = 0;
  try {
    const r = await post("/s/atlas/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, brokePay);
    status = r.status;
    outcome = await r.text();
  } catch (e) {
    outcome = e instanceof Error ? e.message : "client error";
  }
  console.log(`   agent sees: ${outcome.slice(0, 260)}`);
  check("no answer returned", status !== 200, `status ${status}`);
  check("error says the funds could not be locked", outcome.includes("payment_not_locked"));
  check("seller received nothing", (await balance(atlasWallet)) === sellerBefore);
}

title("10. Agent's spending limit: checks the quote and picks a cheaper model");
{
  const CAP = 5_000n;
  const { pay: limited } = perCallClient(agent, CAP.toString());
  const body = { prompt: `${prompt} cap`, max_output_tokens: 500 };
  const quote = async (model: string) =>
    BigInt(((await (await post("/s/atlas/quote", { model, ...body })).json()) as { max_authorized_atomic: string }).max_authorized_atomic);
  const proQuote = await quote("atlas-pro");
  const fastQuote = await quote("atlas-fast");
  console.log(`   limit ${tokens(CAP)}; atlas-pro ceiling ${tokens(proQuote)}; atlas-fast ceiling ${tokens(fastQuote)}`);
  const before = await balances();
  let refused = false;
  try {
    refused = (await post("/s/atlas/generate", { model: "atlas-pro", ...body }, limited)).status !== 200;
  } catch {
    refused = true;
  }
  check("x402 client refuses to lock above its limit", refused);
  check("no money moved", (await balances()).agent === before.agent);
  const chosen = proQuote <= CAP ? "atlas-pro" : "atlas-fast";
  const r = await post("/s/atlas/generate", { model: chosen, ...body }, limited);
  check("switching to the cheaper model succeeds", chosen === "atlas-fast" && r.status === 200, `${chosen}, status ${r.status}`);
  await r.text();
  await sleep(4000);
}

title("11. Payment lands but can't be confirmed: answer isn't lost, no double charge");
{
  await fetch(`${FACILITATOR}/test/unconfirm-next-call`, { method: "POST" });
  const before = await balances();
  const r = await post("/s/atlas/generate", { model: "atlas-fast", prompt: `${prompt} flaky`, max_output_tokens: 300 }, pay);
  const b = (await r.json()) as { error?: string; answer_url?: string };
  console.log(`   agent sees: ${r.status} ${b.error}`);
  check("agent is told it's unconfirmed, not failed", b.error === "payment_unconfirmed");
  check("agent is told where to collect the answer", !!b.answer_url);
  let answer: { text?: string; usage_record?: UsageRecord } = {};
  let collected = 0;
  for (let i = 0; i < 20 && collected !== 200; i++) {
    await sleep(3000);
    const a = await fetch(`${GATEWAY}${b.answer_url}`);
    collected = a.status;
    if (collected === 200) answer = (await a.json()) as typeof answer;
  }
  check("answer collected once the chain confirms", collected === 200 && !!answer.text, `status ${collected}`);
  const charge = BigInt(answer.usage_record?.charged_atomic ?? "-1");
  const after = await settledTo(before, charge);
  check("on-chain: charged once, for the right amount", before.agent - after.agent === charge, tokens(charge));
}

// ──────────────────────────── Paying in a batch ──────────────────────────────

title("12. Repeat caller: one deposit, many fast calls, nothing on-chain per call");
{
  const { pay: batchPay, scheme, proofs: batchProofs, race } = batchClient(agent, [operator]);
  const before = await balances();
  const solBefore = await conn.getBalance(new PublicKey(facilitatorWallet));
  let total = 0n;
  const times: number[] = [];
  let agentAfterOpen = 0n;
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const u = await usageOf(await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt: `${prompt} batch ${i}`, max_output_tokens: 300 }, batchPay));
    times.push(Date.now() - t0);
    total += BigInt(u.charged_atomic);
    if (i === 0) agentAfterOpen = await balance(agent.address);
  }
  const afterOpen = await conn.getBalance(new PublicKey(facilitatorWallet));
  const later = times.slice(1).sort((x, y) => x - y);
  const median = later[Math.floor(later.length / 2)]!;
  console.log(`   first call ${times[0]} ms (opens the channel); next 9 median ${median} ms`);
  console.log(`   10 calls charged ${tokens(total)} tokens in total`);
  check("calls 2 to 10 don't touch the agent's wallet: no on-chain payment per call", (await balance(agent.address)) === agentAfterOpen);

  race.armed = true;
  const raced = await usageOf(await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt: `${prompt} batch race`, max_output_tokens: 300 }, batchPay));
  total += BigInt(raced.charged_atomic);
  check("the same request sent twice at once runs once", [...race.statuses].sort().join() === "200,402", race.statuses.join(" and "));

  const failing = await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt, max_output_tokens: 300, simulate_failure: "provider_error" }, batchPay);
  check("provider failure inside a batch isn't charged", failing.status === 502, `status ${failing.status}`);
  await failing.text();

  const replay = await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt: `${prompt} batch 9`, max_output_tokens: 300 }, fetch, { "payment-signature": batchProofs[batchProofs.length - 2]! });
  const replayText = await replay.text();
  console.log(`   replayed proof, agent sees: ${replayText.slice(0, 120)}`);
  check("a replayed batch proof is refused with a clear error", replay.status === 402 && replayText.includes("payment_proof_reused"), `status ${replay.status}`);

  let brokeText = "";
  try {
    brokeText = await (await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, batchClient(await generateKeyPairSigner(), [operator]).pay)).text();
  } catch (e) {
    brokeText = e instanceof Error ? e.message : "client error";
  }
  check("a wallet with no funds gets a clear batch error", brokeText.includes("payment_not_locked"), brokeText.slice(0, 80));

  const stats = await getJson<{ unclaimedAtomic: string }>("/api/stats?seller=atlas");
  console.log(`   dashboard shows ${tokens(stats.unclaimedAtomic)} metered, not yet claimed`);

  const claimed = await waitFor((n) => n.atlas - before.atlas === total, 90);
  check("on-chain: seller's claim equals the sum of the charges", claimed.atlas - before.atlas === total, tokens(claimed.atlas - before.atlas));

  const refund = await scheme.refund(`${GATEWAY}/s/atlas/channel`);
  check("agent closes the channel and gets its unused deposit back", refund.success === true);
  const after = await waitFor((n) => before.agent - n.agent === total);
  check("on-chain: agent's net cost equals the charges exactly", before.agent - after.agent === total, tokens(before.agent - after.agent));
  const solAfter = await conn.getBalance(new PublicKey(facilitatorWallet));
  console.log(`   facilitator SOL: ${(solBefore - afterOpen) / 1e9} fronted at open; ${(solBefore - solAfter) / 1e9} after refund (rent may still return)`);
}

title("13. An operator the agent doesn't trust: it won't deposit");
{
  const { pay: wary } = batchClient(agent, []);
  const before = await balances();
  let refused = false;
  try {
    refused = (await post("/s/atlas/batch/generate", { model: "atlas-fast", prompt, max_output_tokens: 300 }, wary)).status !== 200;
  } catch {
    refused = true;
  }
  check("x402 client refuses", refused);
  check("no money moved", (await balances()).agent === before.agent);
}

// ─────────────────────────── Sellers bring their own ─────────────────────────

const hour = new Date().getUTCHours();
const notNow = hour >= 12 ? { startHourUtc: 0, endHourUtc: 6 } : { startHourUtc: 18, endHourUtc: 23 };
const novaCard = {
  ...DEMO_RATE_CARD,
  models: { "nova-mini": { input: "500000", cachedInput: "100000", output: "2000000", providerInput: "250000", providerCachedInput: "50000", providerOutput: "1000000", maxOutputTokens: 2000 } },
  peak: { ...notNow, bps: 20_000 },
  minChargeAtomic: "1000",
};

title("14. New seller onboards through the API, with its own wallet and prices");
{
  const unknown = await fetch(`${GATEWAY}/api/stats?seller=no-such-seller`);
  check("an unknown seller's stats are refused, not everyone's", unknown.status === 404, `status ${unknown.status}`);
  const revenue = async (id: string) => {
    const r = await fetch(`${GATEWAY}/api/stats?seller=${id}`);
    return r.status === 404 ? 0n : BigInt(((await r.json()) as { revenueAtomic: string }).revenueAtomic); // Not registered yet.
  };
  const atlasRevenueBefore = await revenue("atlas");
  const novaRevenueBefore = await revenue("nova");
  const reg = { id: "nova", name: "Nova Labs (demo)", payTo: novaWallet, provider: { type: "simulated" }, rateCard: novaCard };
  const noToken = await post("/admin/sellers", reg);
  check("registering needs the admin token", noToken.status === 401, `status ${noToken.status}`);
  const bad = await post("/admin/sellers", { ...reg, rateCard: { ...novaCard, models: {} } }, fetch, ADMIN);
  check("a bad rate card is refused", bad.status === 400, `status ${bad.status}`);
  const emptyWallet = await post("/admin/sellers", { ...reg, id: "no-wallet", payTo: (await generateKeyPairSigner()).address }, fetch, ADMIN);
  check("a wallet that can't hold the token is refused up front", emptyWallet.status === 400, `status ${emptyWallet.status}`);
  const ok = await post("/admin/sellers", reg, fetch, ADMIN);
  check("seller is registered", ok.status === 201, `status ${ok.status}`);
  console.log(`   endpoints: ${JSON.stringify(((await ok.json()) as { endpoints: unknown }).endpoints)}`);

  const before = await balances();
  const u = await usageOf(await post("/s/nova/generate", { model: "nova-mini", prompt: `${prompt} nova`, max_output_tokens: 100 }, pay));
  const charge = BigInt(u.charged_atomic);
  const after = await settledTo(before, charge, "nova");
  check("pays the new seller's wallet", after.nova - before.nova === charge, tokens(charge));
  check("other seller's wallet is untouched", after.atlas === before.atlas);
  check("live off-peak pricing, from this seller's own hours", u.period === "off-peak", u.period);
  await sleep(3000);

  const tiny = await usageOf(await post("/s/nova/generate", { model: "nova-mini", prompt: "hi", max_output_tokens: 1 }, pay));
  check("seller's minimum charge covers network fees on tiny calls", tiny.charged_atomic === "1000", tiny.charged_atomic);
  await sleep(3000);

  // The guided setup a seller would really use, then a real payment to it.
  const setup = spawnSync(process.execPath, ["--import", "tsx", "scripts/add-seller.ts", "--id", "guided", "--name", "Guided Seller (demo)", "--wallet", novaWallet, "--model", "guided-model", "--input", "1", "--output", "4", "--cost-input", "0.5", "--cost-output", "2", "--min", "0.001", "--no-prompt"], { encoding: "utf8", env: process.env });
  check("guided seller setup finishes", setup.status === 0, setup.status === 0 ? "" : setup.stderr.slice(0, 160));
  const guidedBefore = await balances();
  const g = await usageOf(await post("/s/guided/generate", { model: "guided-model", prompt: `${prompt} guided`, max_output_tokens: 100 }, pay));
  const guidedAfter = await settledTo(guidedBefore, BigInt(g.charged_atomic), "nova");
  check("on-chain: that seller gets paid straight away", guidedAfter.nova - guidedBefore.nova === BigInt(g.charged_atomic), tokens(g.charged_atomic));
  await sleep(3000);

  const batchNova = batchClient(agent, [operator]);
  const novaBefore = await balances();
  const m = await usageOf(await post("/s/nova/batch/generate", { model: "nova-mini", prompt: `${prompt} nova batch`, max_output_tokens: 100 }, batchNova.pay));
  const mCharge = BigInt(m.charged_atomic);
  const claimedNova = await waitFor((n) => n.nova - novaBefore.nova === mCharge, 90);
  check("on-chain: batch claim pays this seller, not another", claimedNova.nova - novaBefore.nova === mCharge && claimedNova.atlas === novaBefore.atlas, tokens(mCharge));
  const novaRefund = await batchNova.scheme.refund(`${GATEWAY}/s/nova/channel`);
  check("agent closes its channel with this seller", novaRefund.success === true);

  const { recent: novaRows } = await getJson<{ recent: { sellerId?: string }[] }>("/api/stats?seller=nova");
  check("this seller's revenue is exactly its own calls", (await revenue("nova")) - novaRevenueBefore === charge + 1000n + mCharge, tokens((await revenue("nova")) - novaRevenueBefore));
  check("other sellers' revenue didn't change", (await revenue("atlas")) === atlasRevenueBefore);
  check("this seller's list shows only its own calls", novaRows.length > 0 && novaRows.every((e) => e.sellerId === "nova"));
}

title("15. Seller uses its own model endpoint");
{
  let mode = "ok";
  let upstreamCalls = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamCalls++;
      res.writeHead(mode === "down" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: mode === "empty" ? "" : "Answer from the seller's own model", usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 90 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(4041, r));
  const reg = await post("/admin/sellers", { id: "relay", name: "Relay Models (demo)", payTo: novaWallet, provider: { type: "http", url: "http://localhost:4041/complete" }, rateCard: novaCard }, fetch, ADMIN);
  check("seller registered with its endpoint", reg.status === 201, `status ${reg.status}`);

  const before = await balances();
  const r = await post("/s/relay/generate", { model: "nova-mini", prompt: `${prompt} relay`, max_output_tokens: 200 }, pay);
  const b = (await r.json()) as { text: string; usage_record: UsageRecord };
  const charge = BigInt(b.usage_record.charged_atomic);
  const after = await settledTo(before, charge, "nova");
  check("answer comes from the seller's endpoint", b.text.includes("seller's own model"));
  check("charged from the usage the endpoint reported", b.usage_record.tokens.outputTokens === 90 && before.agent - after.agent === charge, tokens(charge));

  mode = "down";
  const failBefore = await balances();
  const f = await post("/s/relay/generate", { model: "nova-mini", prompt: `${prompt} relay2`, max_output_tokens: 200 }, pay);
  await f.text();
  check("endpoint outage returns 502", f.status === 502, `status ${f.status}`);
  const failAfter = await settledTo(failBefore, 0n, "nova");
  check("on-chain: agent isn't charged for the outage", failAfter.agent === failBefore.agent);

  mode = "empty";
  const emptyBefore = await balances();
  const e = await post("/s/relay/generate", { model: "nova-mini", prompt: `${prompt} relay3`, max_output_tokens: 200 }, pay);
  const eb = (await e.json()) as { usage_record: { id: string } };
  check("an answer with no text returns 502", e.status === 502, `status ${e.status}`);
  const emptyAfter = await settledTo(emptyBefore, 0n, "nova");
  check("on-chain: agent isn't charged for a blank answer", emptyAfter.agent === emptyBefore.agent);
  const er = await getJson<{ status: string; providerCostAtomic: string }>(`/v1/receipts/${eb.usage_record.id}`);
  check("ledger records what the blank answer cost the seller", er.status === "refunded" && BigInt(er.providerCostAtomic) > 0n, er.providerCostAtomic);
  check("endpoint was really called three times", upstreamCalls === 3, String(upstreamCalls));
  upstream.close();
}

title("16. Heavy use moves the agent to a cheaper tier");
{
  const big = `[${runId}] ${"long document ".repeat(200)}`;
  const u1 = await usageOf(await post("/s/atlas/generate", { model: "atlas-fast", prompt: big, max_output_tokens: 4000 }, pay));
  console.log(`   large call: ${u1.tokens.inputTokens + u1.tokens.outputTokens} AI tokens, tier ${u1.tier}`);
  await sleep(3000);
  const u2 = await usageOf(await post("/s/atlas/generate", { model: "atlas-fast", prompt: `${prompt} after`, max_output_tokens: 100 }, pay));
  check("next call is in the growth tier", u2.tier === "growth", u2.tier);
}

title("Seller's view");
{
  interface NetworkView { transactions: number; feesAtomic: string }
  const a = await getJson<{
    marginAtomic: string;
    byScheme: Record<string, { calls: number }>;
    network: { feesAtomic: string; marginAfterModelAndNetworkAtomic: string; upto: NetworkView; "batch-settlement": NetworkView };
  }>("/api/stats?seller=atlas");
  const perCall = Number(a.network.upto.feesAtomic) / a.byScheme.upto!.calls;
  const perBatchCall = Number(a.network["batch-settlement"].feesAtomic) / a.byScheme["batch-settlement"]!.calls;
  console.log(`   estimated network fees per call: per-call ${tokens(BigInt(Math.ceil(perCall)))}, batch ${tokens(BigInt(Math.ceil(perBatchCall)))}`);
  check("the margin after network fees subtracts them exactly", BigInt(a.marginAtomic) - BigInt(a.network.feesAtomic) === BigInt(a.network.marginAfterModelAndNetworkAtomic));
  check("batch costs less in network fees per call than paying per call", perBatchCall < perCall, `${Math.ceil(perBatchCall)} vs ${Math.ceil(perCall)} atomic`);
  const s = await getJson<{ revenueAtomic: string; modelCostAtomic: string; marginAtomic: string; counts: Record<string, number> }>("/api/stats");
  console.log(`   all sellers: revenue ${tokens(s.revenueAtomic)}  model cost ${tokens(s.modelCostAtomic)}  margin ${tokens(s.marginAtomic)}`);
  console.log(`   calls: ${JSON.stringify(s.counts)}`);
  console.log(`   dashboard: ${GATEWAY}/`);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
