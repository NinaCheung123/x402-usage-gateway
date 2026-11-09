/**
 * Crash test, on real devnet money movements. It starts its own services, so
 * stop `npm start` first, and it stops everything it started when it finishes.
 *
 * Part 1: force-kill the gateway while it holds unclaimed vouchers (the seller's
 * money), start a new one, and check the seller is still paid in full.
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
