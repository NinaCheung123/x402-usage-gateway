import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger, type Entry } from "../src/ledger.js";

const dir = mkdtempSync(join(tmpdir(), "ledger-"));
const entry = (over: Partial<Entry>): Entry => ({
  id: "a",
  at: "2026-11-08T00:00:00Z",
  status: "settled",
  chargeAtomic: "100",
  providerCostAtomic: "40",
  ...over,
});

test("a half-written last line doesn't stop the ledger, and new records stay readable", () => {
  const path = join(dir, "partial.jsonl");
  new Ledger(path).put(entry({ id: "good" }));
  appendFileSync(path, '{"id":"half","stat');
  const reopened = new Ledger(path);
  assert.equal(reopened.get("good")?.status, "settled");
  assert.equal(reopened.get("half"), undefined);
  reopened.put(entry({ id: "after" }));
  assert.equal(new Ledger(path).get("after")?.status, "settled");
  assert.ok(readFileSync(path, "utf8").includes('\n{"id":"after"'));
});

test("a blank answer counts as the seller's cost but not as revenue", () => {
  const ledger = new Ledger(join(dir, "cost.jsonl"));
  ledger.put(entry({ id: "paid" }));
  ledger.put(entry({ id: "blank", status: "refunded", chargeAtomic: "0", providerCostAtomic: "25" }));
  const s = ledger.stats();
  assert.equal(s.revenueAtomic, "100");
  assert.equal(s.modelCostAtomic, "65");
  assert.equal(s.marginAtomic, "35");
});

test("unresolved calls don't count as revenue", () => {
  const ledger = new Ledger(join(dir, "open.jsonl"));
  for (const status of ["pending", "needs_review", "refund_pending", "rejected"] as const)
    ledger.put(entry({ id: status, status, providerCostAtomic: "0" }));
  assert.equal(ledger.stats().revenueAtomic, "0");
});

test("each seller's numbers and tiers are its own", () => {
  const ledger = new Ledger(join(dir, "sellers.jsonl"));
  const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 };
  ledger.put(entry({ id: "1", sellerId: "x", payer: "p", usage }));
  ledger.put(entry({ id: "2", sellerId: "y", payer: "p", usage, chargeAtomic: "7" }));
  assert.equal(ledger.stats("y").revenueAtomic, "7");
  assert.equal(ledger.tokensBilled("x", "p"), 20);
  assert.equal(ledger.tokensBilled("z", "p"), 0);
});
