/**
 * Crash test, on real devnet money movements. It starts its own services, so
 * stop `npm start` first, and it stops everything it started when it finishes.
 *
 * Part 1: force-kill the gateway while it holds unclaimed vouchers (the seller's
 * money), start a new one, and check the seller is still paid in full.
 * Part 1b: kill the gateway at three moments inside a batch call, and check both
 * sides are told what happened and that the money matches what was really charged.
 * Part 2: make a refund fail, force-kill the facilitator, start a new one, and
 * check the agent's locked funds still come back. Part 2 waits for channel
 * cleanup, so it takes several minutes.
 */
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { x402Client } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";

const GATEWAY = "http://localhost:4021";
const FACILITATOR = "http://localhost:4022";
const RPC = "http://localhost:8899";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const MINT = new PublicKey(process.env.TEST_MINT!);
const conn = new Connection(RPC, "confirmed");
const keyOf = (n: string) => createKeyPairSignerFromBytes(base58.decode(process.env[n]!.trim()));
const agentSigner = await keyOf("AGENT_KEY");
const agent = agentSigner.address;
const seller = (await keyOf("SELLER_KEY")).address;
const operator = (await keyOf("OPERATOR_KEY")).address;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const balance = async (o: string) =>
  (await getAccount(conn, getAssociatedTokenAddressSync(MINT, new PublicKey(o)))).amount;
const JSON_HEADERS = { "content-type": "application/json" };

class StopEarly extends Error {}

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

mkdirSync("logs", { recursive: true });
const env = { ...process.env, RPC_SHIELD_URL: RPC, ALLOW_SIMULATED_FAILURES: "true" };
function start(name: string, file: string): ChildProcess {
  const log = openSync(`logs/crash-test-${name}.log`, "a");
  return spawn(process.execPath, ["--import", "tsx", file], { env, stdio: ["ignore", log, log] });
}
const reachable = (url: string, init?: RequestInit) => fetch(url, init).then(() => true, () => false);
async function untilUp(url: string, init?: RequestInit) {
  const deadline = Date.now() + 60_000;
  while (!(await reachable(url, init))) {
    if (Date.now() > deadline) throw new Error(`${url} wasn't ready after 60 seconds`);
    await sleep(500);
  }
}
const stopped = (child: ChildProcess) =>
  new Promise((r) => (child.exitCode !== null || child.signalCode ? r(undefined) : child.once("exit", r)));

const rpcHealth = { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' };
for (const url of [GATEWAY + "/", FACILITATOR + "/supported"]) {
  if (await reachable(url)) {
    console.error(`Something is already running at ${url}. Stop \`npm start\` first; this test starts its own services.`);
    process.exit(1);
  }
}

const procs: Record<string, ChildProcess> = {};
procs.rpc = start("rpc", "src/rpc-shield.ts");
await untilUp(RPC, rpcHealth);
procs.facilitator = start("facilitator", "src/facilitator.ts");
await untilUp(`${FACILITATOR}/supported`);
procs.gateway = start("gateway", "src/gateway.ts");
await untilUp(`${GATEWAY}/s/atlas/pricing`);

try {
  console.log("\n── Part 1: the gateway crashes while it holds the seller's money");
  const batch = new BatchSvmScheme(agentSigner, {
    rpcUrl: RPC,
    serverSignedChannelsPolicy: {
      allowedOperators: [operator],
      allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxDeposit: "200000" }],
    },
  } as never);
  const spend = { allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxAmountPerPayment: "1000000" }] };
  const batchProofs: string[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const proof = req.headers.get("payment-signature");
    if (proof) batchProofs.push(proof);
    return fetch(req);
  };
  const batchPay = wrapFetchWithPayment(recordingFetch, new x402Client().register("solana:*", batch).setSpendControls(spend));

  const before = { seller: await balance(seller), agent: await balance(agent) };
  let total = 0n;
  let lastBody = "";
  for (let i = 0; i < 4; i++) {
    lastBody = JSON.stringify({ model: "atlas-fast", prompt: `crash test ${Date.now()} ${i}`, max_output_tokens: 300 });
    const r = await batchPay(`${GATEWAY}/s/atlas/batch/generate`, { method: "POST", headers: JSON_HEADERS, body: lastBody });
    const b = (await r.json()) as { usage_record: { charged_atomic: string } };
    total += BigInt(b.usage_record.charged_atomic);
  }
  console.log(`   4 metered calls, ${total} atomic units owed to the seller`);

  const usedProof = batchProofs[batchProofs.length - 1]!;
  const replayProof = () =>
    fetch(`${GATEWAY}/s/atlas/batch/generate`, { method: "POST", headers: { ...JSON_HEADERS, "payment-signature": usedProof }, body: lastBody });
  const before402 = await replayProof();
  check("a used proof is refused before the crash", before402.status === 402, `status ${before402.status}`);
  await before402.text();

  const stats = (await (await fetch(`${GATEWAY}/api/stats?seller=atlas`)).json()) as { unclaimedAtomic: string };
  check("gateway holds unclaimed vouchers at the moment of the crash", BigInt(stats.unclaimedAtomic) > 0n, `${stats.unclaimedAtomic} unclaimed`);

  procs.gateway!.kill("SIGKILL");
  await stopped(procs.gateway!);
  console.log("   gateway force-killed (no clean shutdown, no final claim)");
  check("gateway is really down", !(await reachable(`${GATEWAY}/`)));

  procs.gateway = start("gateway", "src/gateway.ts");
  await untilUp(`${GATEWAY}/s/atlas/pricing`);
  const after = await replayProof();
  const afterText = await after.text();
  check("the same used proof is still refused after the restart", after.status === 402 && afterText.includes("payment_proof_reused"), `status ${after.status} ${afterText.slice(0, 60)}`);
  const recovered = await fetch(`${GATEWAY}/v1/recover`, { method: "POST", headers: { "payment-signature": usedProof } });
  const recoveredBody = (await recovered.json()) as { text?: string };
  check("its answer can still be recovered after the restart, for free", recovered.status === 200 && !!recoveredBody.text, `status ${recovered.status}`);
  console.log("   new gateway started; waiting for it to claim");

  let paid = 0n;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
    await sleep(4000);
    paid = (await balance(seller)) - before.seller;
    if (paid === total) break;
  }
  check("on-chain: seller received everything it was owed", paid === total, `${paid} of ${total}`);

  const refund = await batch.refund(`${GATEWAY}/s/atlas/channel`);
  check("agent still closes its channel after the crash", refund.success === true);
  await sleep(6000);
  const net = before.agent - (await balance(agent));
  check("on-chain: agent's net cost equals the charges exactly", net === total, `${net}`);

  console.log("\n── Part 1b: the gateway crashes in the middle of a batch call");
  const midProofs: string[] = [];
  // An x402 client stays stuck on a channel once a request dies with no response,
  // so an agent starts a new client after a crash. This test does the same.
  const newMidClient = () => wrapFetchWithPayment(
    async (input, init) => {
      const req = new Request(input, init);
      const proof = req.headers.get("payment-signature");
      if (proof) midProofs.push(proof);
      return fetch(req);
    },
    new x402Client()
      .register("solana:*", new BatchSvmScheme(agentSigner, {
        rpcUrl: RPC,
        serverSignedChannelsPolicy: {
          allowedOperators: [operator],
          allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxDeposit: "200000" }],
        },
      } as never))
      .setSpendControls(spend),
  );
  let midPay = newMidClient();
  const midStart = { seller: await balance(seller), agent: await balance(agent) };
  let midTotal = 0n;
  const generateBody = (prompt: string, simulate_failure?: string) =>
    JSON.stringify({ model: "atlas-fast", prompt, max_output_tokens: 300, ...(simulate_failure ? { simulate_failure } : {}) });
  const paidCall = async (prompt: string) => {
    const r = await midPay(`${GATEWAY}/s/atlas/batch/generate`, { method: "POST", headers: JSON_HEADERS, body: generateBody(prompt) });
    const b = (await r.json()) as { usage_record: { charged_atomic: string } };
    if (r.status !== 200) throw new Error(`a normal call failed with ${r.status}`);
    midTotal += BigInt(b.usage_record.charged_atomic);
  };
  /** Sends a call that kills the gateway, then starts a new gateway. Returns its proof. */
  const callThatCrashes = async (point: string) => {
    const died = await midPay(`${GATEWAY}/s/atlas/batch/generate`, { method: "POST", headers: JSON_HEADERS, body: generateBody(`mid-call ${point} ${Date.now()}`, point) }).then(
      () => false,
      () => true,
    );
    check(`${point}: the gateway really died and the agent got no response`, died);
    midPay = newMidClient();
    await stopped(procs.gateway!);
    procs.gateway = start("gateway", "src/gateway.ts");
    await untilUp(`${GATEWAY}/s/atlas/pricing`);
    return midProofs[midProofs.length - 1]!;
  };
  const recover = (proof: string) => fetch(`${GATEWAY}/v1/recover`, { method: "POST", headers: { "payment-signature": proof } });
  interface Notice {
    status?: string;
    answer_held?: boolean;
    charged_atomic?: string;
    price_atomic?: string;
    resume_url?: string;
    receipt_url?: string;
    text?: string;
    usage_record?: { id: string; charged_atomic: string };
  }

  await paidCall(`mid-call opener ${Date.now()}`);

  // After the answer, before the charge.
  const heldProof = await callThatCrashes("crash_after_answer");
  const heldRes = await recover(heldProof);
  const held = (await heldRes.json()) as Notice;
  check("held answer: the agent is told it wasn't charged", heldRes.status === 409 && held.status === "interrupted" && held.charged_atomic === "0", `status ${heldRes.status}`);
  check("held answer: the agent is told the price and where to pay", held.answer_held === true && BigInt(held.price_atomic ?? "0") > 0n && !!held.resume_url, `price ${held.price_atomic}`);
  check("held answer: it isn't given away by asking", held.text === undefined);
  const heldRetry = await fetch(`${GATEWAY}/s/atlas/batch/generate`, { method: "POST", headers: { ...JSON_HEADERS, "payment-signature": heldProof }, body: generateBody("retry") });
  const heldRetryBody = (await heldRetry.json()) as { interrupted?: Notice };
  check("held answer: retrying the old proof is refused and points to the held answer", heldRetry.status === 402 && heldRetryBody.interrupted?.answer_held === true, `status ${heldRetry.status}`);
  const statsHeld = (await (await fetch(`${GATEWAY}/api/stats?seller=atlas`)).json()) as { attention: { id: string; answerHeld: boolean; uncollectedAtomic: string }[] };
  const heldId = held.resume_url!.split("/").at(-1)!;
  const sellerView = statsHeld.attention.find((a) => a.id === heldId);
  check("held answer: the seller sees the uncollected charge", sellerView?.answerHeld === true && sellerView.uncollectedAtomic === held.price_atomic, sellerView?.uncollectedAtomic);
  const rewrites = [`/S/atlas/batch/resume/${heldId}`, `/s/atlas/BATCH/RESUME/${heldId}`, `/s/atlas/batch/resume/${heldId}/`, `/s/atlas/batch//resume/${heldId}`, `/s/%61tlas/batch/resume/${heldId}`, `/s/atlas/batch/resume/%2e/${heldId}`];
  const rewriteStatuses: number[] = [];
  for (const path of rewrites) {
    const r = await fetch(GATEWAY + path, { method: "POST" });
    rewriteStatuses.push(r.status);
    await r.text();
  }
  check("held answer: rewritten paths never get it free", rewriteStatuses.every((s) => s !== 200), rewriteStatuses.join(" "));
  const heldBalance = await balance(agent);
  const noPay = await fetch(`${GATEWAY}${held.resume_url}`, { method: "POST" });
  await noPay.text();
  check("held answer: collecting it without paying gets a 402", noPay.status === 402, `status ${noPay.status}`);
  check("held answer: asking moved no money", (await balance(agent)) === heldBalance);
  const resumed = await midPay(`${GATEWAY}${held.resume_url}`, { method: "POST" });
  const resumedBody = (await resumed.json()) as Notice;
  check("held answer: paying the original price returns the answer", resumed.status === 200 && !!resumedBody.text, `status ${resumed.status}`);
  midTotal += BigInt(held.price_atomic ?? "0");
  await sleep(500);
  const heldReceipt = (await (await fetch(`${GATEWAY}${held.receipt_url}`)).json()) as { status: string };
  check("held answer: the ledger now says it was charged", heldReceipt.status === "metered", heldReceipt.status);
  const resumeTwice = await fetch(`${GATEWAY}${held.resume_url}`, { method: "POST" });
  await resumeTwice.text();
  check("held answer: it can't be paid for twice", resumeTwice.status === 409, `status ${resumeTwice.status}`);
  const heldAgain = await recover(heldProof);
  await heldAgain.text();
  check("held answer: if that response is lost too, it's now free to collect", heldAgain.status === 200, `status ${heldAgain.status}`);

  // Before any answer exists.
  const noAnswerProof = await callThatCrashes("crash_before_answer");
  const noAnswerRes = await recover(noAnswerProof);
  const noAnswer = (await noAnswerRes.json()) as Notice;
  check("no answer: the agent is told it wasn't charged and has nothing to collect", noAnswerRes.status === 409 && noAnswer.answer_held === false && noAnswer.charged_atomic === "0", `status ${noAnswerRes.status}`);
  const statsNone = (await (await fetch(`${GATEWAY}/api/stats?seller=atlas`)).json()) as { attention: { id: string; whatToDo: string }[] };
  check("no answer: the seller is warned its model may have billed it", statsNone.attention.some((a) => /may still have billed/.test(a.whatToDo)));
  await paidCall(`mid-call after crash ${Date.now()}`);
  check("no answer: a new request works straight after", true);

  // After the charge, before the ledger write.
  const chargedProof = await callThatCrashes("crash_after_charge");
  const chargedRes = await recover(chargedProof);
  const charged = (await chargedRes.json()) as Notice;
  check("already charged: the answer is free to collect", chargedRes.status === 200 && !!charged.text, `status ${chargedRes.status}`);
  midTotal += BigInt(charged.usage_record?.charged_atomic ?? "0");
  const chargedId = charged.usage_record?.id;
  const chargedReceipt = (await (await fetch(`${GATEWAY}/v1/receipts/${chargedId}`)).json()) as { status: string };
  check("already charged: the ledger caught up from the payment records", chargedReceipt.status === "metered", chargedReceipt.status);
  const chargedResume = await fetch(`${GATEWAY}/s/atlas/batch/resume/${chargedId}`, { method: "POST" });
  await chargedResume.text();
  check("already charged: it can't be billed a second time", chargedResume.status === 409, `status ${chargedResume.status}`);

  let midPaid = 0n;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
    await sleep(4000);
    midPaid = (await balance(seller)) - midStart.seller;
    if (midPaid === midTotal) break;
  }
  check("on-chain: seller received exactly what was charged", midPaid === midTotal, `${midPaid} of ${midTotal}`);
  const midRefund = await (async () => {
    const refundScheme = new BatchSvmScheme(agentSigner, {
      rpcUrl: RPC,
      serverSignedChannelsPolicy: {
        allowedOperators: [operator],
        allowedAssets: [{ network: NETWORK, asset: MINT.toBase58(), maxDeposit: "200000" }],
      },
    } as never);
    return refundScheme.refund(`${GATEWAY}/s/atlas/channel`);
  })();
  check("agent closes its channel straight after the crashes", midRefund.success === true);
  await sleep(6000);
  const midNet = midStart.agent - (await balance(agent));
  check("on-chain: agent's net cost equals what was charged, with no double charge", midNet === midTotal, `${midNet} of ${midTotal}`);

  if (process.argv.includes("--part1")) throw new StopEarly();

  console.log("\n── Part 2: a refund fails, then the facilitator crashes");
  const perCallPay = wrapFetchWithPayment(
    fetch,
    new x402Client().register("solana:*", new UptoSvmScheme(agentSigner, { rpcUrl: RPC } as never)).setSpendControls(spend),
  );
  const perCallProofs: string[] = [];
  const perCallBody = JSON.stringify({ model: "atlas-fast", prompt: `replay test ${Date.now()}`, max_output_tokens: 300 });
  const paidOnce = await wrapFetchWithPayment(
    async (input, init) => {
      const req = new Request(input, init);
      const proof = req.headers.get("payment-signature");
      if (proof) perCallProofs.push(proof);
      return fetch(req);
    },
    new x402Client().register("solana:*", new UptoSvmScheme(agentSigner, { rpcUrl: RPC } as never)).setSpendControls(spend),
  )(`${GATEWAY}/s/atlas/generate`, { method: "POST", headers: JSON_HEADERS, body: perCallBody });
  await paidOnce.text();
  await sleep(8000);

  const agentBefore = await balance(agent);
  const sellerBefore = await balance(seller);
  await fetch(`${FACILITATOR}/test/fail-next-refund`, { method: "POST" });
  const r = await perCallPay(`${GATEWAY}/s/atlas/generate`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: "atlas-fast", prompt: `refund test ${Date.now()}`, max_output_tokens: 300, simulate_failure: "provider_error" }),
  });
  const b = (await r.json()) as { usage_record: { id: string } };
  check("provider failure returns 502", r.status === 502, `status ${r.status}`);
  await sleep(500);
  const receipt = (await (await fetch(`${GATEWAY}/v1/receipts/${b.usage_record.id}`)).json()) as { status: string };
  check("ledger says the refund is pending, not done", receipt.status === "refund_pending", receipt.status);
  const locked = agentBefore - (await balance(agent));
  check("the funds really are still locked", locked > 0n, `${locked} locked`);

  procs.facilitator!.kill("SIGKILL");
  await stopped(procs.facilitator!);
  console.log("   facilitator force-killed with that channel open");
  procs.facilitator = start("facilitator", "src/facilitator.ts");
  await untilUp(`${FACILITATOR}/supported`);
  const perCallReplay = await fetch(`${GATEWAY}/s/atlas/generate`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "payment-signature": perCallProofs[perCallProofs.length - 1]! },
    body: perCallBody,
  });
  const perCallReplayText = await perCallReplay.text();
  check("a used per-call proof is refused after the facilitator restarts", perCallReplay.status === 402, `status ${perCallReplay.status} ${perCallReplayText.slice(0, 60)}`);
  console.log("   new facilitator started; waiting for cleanup to return the funds (up to 8 minutes)");

  let back = await balance(agent);
  for (const deadline = Date.now() + 480_000; Date.now() < deadline && back !== agentBefore; ) {
    await sleep(10_000);
    back = await balance(agent);
  }
  check("on-chain: agent got its locked funds back", back === agentBefore, `${agentBefore - back} still locked`);
  check("on-chain: seller received nothing", (await balance(seller)) === sellerBefore);
} catch (e) {
  if (!(e instanceof StopEarly)) {
    failed++;
    console.error("   FAIL ", e instanceof Error ? e.message : e);
  }
} finally {
  for (const child of [procs.gateway, procs.facilitator, procs.rpc]) {
    child?.kill("SIGTERM");
    await Promise.race([stopped(child!), sleep(15_000)]);
    child?.kill("SIGKILL"); // No effect if it has already stopped.
  }
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
