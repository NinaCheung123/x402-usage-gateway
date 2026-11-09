import { InMemoryBatchChannelStorage } from "@x402/svm/batch-settlement/facilitator";
import { InMemoryPaymentChannelStorage } from "@x402/svm/upto/facilitator";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableChannelStore, DurableOperationStore, durableStorage } from "../src/durable.js";

const dir = mkdtempSync(join(tmpdir(), "durable-"));
const record = {
  network: "solana:devnet",
  channelId: "chan1",
  payTo: "seller",
  tokenProgram: "tp",
  expiresAt: 10,
  lastActivityAt: 5,
  receiverAuthorizer: "",
  callerIdentity: "",
};

for (const [name, make] of [
  ["upto", () => new InMemoryPaymentChannelStorage()],
  ["batch", () => new InMemoryBatchChannelStorage()],
] as const) {
  test(`${name} facilitator records survive a restart`, async () => {
    const path = join(dir, `${name}.json`);
    const first = durableStorage(make(), path);
    await first.recordActivity(record as never);
    const second = durableStorage(make(), path);
    const rows = await second.list("solana:devnet" as never);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.channelId, "chan1");
  });
}

test("the seller's unclaimed vouchers survive a restart, bigints intact", async () => {
  const path = join(dir, "gateway.json");
  const first = new DurableChannelStore(path);
  const state = { channelId: "c1", deposit: 6000n, signedMaxClaimable: 718n, settled: 0n, salt: 9007199254740993n } as never;
  await first.put(state);
  await first.update("c1", (c) => ({ ...c!, signedMaxClaimable: 800n }));
  const second = new DurableChannelStore(path);
  const got = (await second.get("c1"))!;
  assert.equal(got.signedMaxClaimable, 800n);
  assert.equal(got.salt, 9007199254740993n);
  assert.equal((await second.list()).length, 1);
});

test("a wallet's redemption view lists only that wallet's channels", async () => {
  const store = new DurableChannelStore(join(dir, "views.json"));
  await store.put({ channelId: "a", receiver: "wallet-a" } as never);
  await store.put({ channelId: "b", receiver: "wallet-b" } as never);
  const view = store.forReceiver("wallet-a");
  assert.deepEqual((await view.list!()).map((c) => c.channelId), ["a"]);
  assert.equal((await view.get("b"))?.channelId, "b");
  assert.equal((await store.list()).length, 2);
});

test("a used batch request is still known after a restart", async () => {
  const path = join(dir, "ops.jsonl");
  const first = new DurableOperationStore(path);
  assert.equal((await first.reserve("c", "r1", 500n)).created, true);
  await first.complete({ status: "completed", channelId: "c", requestId: "r1", ceiling: 500n, actual: 65n, cumulative: 65n });
  await first.reserve("c", "r2", 500n); // Crashed mid-call: reserved, never completed.
  first.close();

  const second = new DurableOperationStore(path);
  const again = await second.reserve("c", "r1", 500n);
  assert.equal(again.created, false);
  assert.equal(again.operation.status, "completed");
  assert.equal((await second.reserve("c", "r2", 500n)).created, false);
  assert.equal((await second.reserve("c", "new", 500n)).created, true);
  second.close();
});

test("a failed batch request's ID can't be used again", async () => {
  const store = new DurableOperationStore(join(dir, "ops-release.jsonl"));
  await store.reserve("c", "r", 5n);
  await store.release("c", "r");
  assert.equal((await store.reserve("c", "r", 5n)).created, false);
  store.close();
});

test("a half-written request record doesn't block startup or later records", async () => {
  const path = join(dir, "ops-partial.jsonl");
  const first = new DurableOperationStore(path);
  await first.reserve("c", "good", 5n);
  first.close();
  appendFileSync(path, '{"status":"res');
  const second = new DurableOperationStore(path);
  assert.equal((await second.reserve("c", "good", 5n)).created, false);
  await second.reserve("c", "after", 5n);
  second.close();
  const third = new DurableOperationStore(path);
  assert.equal((await third.reserve("c", "after", 5n)).created, false);
  third.close();
});
