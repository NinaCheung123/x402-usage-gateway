import { InMemoryBatchChannelStorage } from "@x402/svm/batch-settlement/facilitator";
import { InMemoryPaymentChannelStorage } from "@x402/svm/upto/facilitator";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableChannelStore, durableStorage } from "../src/durable.js";

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
