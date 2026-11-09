import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { feeAssumptions, networkCostAtomic } from "../src/costs.js";
import { TransactionCounter } from "../src/durable.js";

const at150 = { lamportsPerTx: 10_001, solPriceTokens: 150 };

test("one per-call payment costs about 0.003 tokens at the measured fee", () => {
  assert.equal(networkCostAtomic(2, at150), 3_001n); // 3,000.3 rounded up
});

test("no transactions cost nothing", () => {
  assert.equal(networkCostAtomic(0, at150), 0n);
});

test("fees scale with the SOL price", () => {
  assert.equal(networkCostAtomic(2, { ...at150, solPriceTokens: 300 }), 6_001n);
});

test("unusable settings fall back to the defaults", () => {
  assert.deepEqual(feeAssumptions({ ASSUMED_SOL_PRICE: "cheap", ASSUMED_LAMPORTS_PER_TX: "-5" }), at150);
  assert.equal(feeAssumptions({ ASSUMED_SOL_PRICE: "200" }).solPriceTokens, 200);
});

test("claim counts survive a restart and stay per wallet", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tx-")), "tx.json");
  const first = new TransactionCounter(path);
  first.add("a");
  first.add("a");
  first.add("b");
  const second = new TransactionCounter(path);
  assert.equal(second.get("a"), 2);
  assert.equal(second.get("missing"), 0);
  assert.equal(second.total(), 3);
});
