import type { BatchOperation, ChannelState } from "@x402/svm/batch-settlement/server";
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentNotice, canResume, needsAttention, operationLink, reconcile, sellerNotice } from "../src/interrupted.js";
import type { Entry } from "../src/ledger.js";

const link = { channelId: "c", requestId: "r" };
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: "e1",
  at: "2026-11-09T00:00:00Z",
  status: "pending",
  sellerId: "atlas",
  scheme: "batch-settlement",
  chargeAtomic: "65",
  providerCostAtomic: "20",
  operation: link,
  answer: { text: "secret-answer-text" },
  ...over,
});
const reserved: BatchOperation = { status: "reserved", ...link, ceiling: 300n };
const completed: BatchOperation = { status: "completed", ...link, ceiling: 300n, actual: 65n, cumulative: 165n };
const channelAt = (charged: bigint) => ({ chargedCumulativeAmount: charged }) as ChannelState;

test("the proof's IDs link it to its operation, and a proof without them doesn't", () => {
  assert.deepEqual(operationLink({ authorization: { channelId: "c", requestId: "r", payer: "p" } }), link);
  assert.equal(operationLink({ voucher: {} }), undefined);
  assert.equal(operationLink({ authorization: { channelId: "c" } }), undefined);
  assert.equal(operationLink(undefined), undefined);
});

test("charged but not recorded: the ledger catches up and the agent can't be billed again", () => {
  const change = reconcile(entry(), completed, channelAt(165n));
  assert.equal(change.status, "metered");
  assert.equal(change.chargeAtomic, "65");
  assert.equal(canResume({ ...entry(), ...change }), false);
});

test("operation completed but the channel never saved it: that is not a charge", () => {
  const change = reconcile(entry(), completed, channelAt(100n));
  assert.equal(change.status, "interrupted");
  assert.equal(canResume({ ...entry(), ...change }), true);
});

test("a missing channel record never counts as a charge", () => {
  assert.equal(reconcile(entry(), completed, undefined).status, "interrupted");
});

test("answer saved, no charge: the agent may pay to collect it", () => {
  const e = { ...entry(), ...reconcile(entry(), reserved, channelAt(100n)) };
  assert.equal(e.status, "interrupted");
  assert.equal(e.operation, undefined, "the link must clear, or later charges would look like this one");
  const notice = agentNotice(e);
  assert.equal(notice.answer_held, true);
  assert.equal(notice.charged_atomic, "0");
  assert.equal(notice.price_atomic, "65");
  assert.equal(notice.resume_url, "/s/atlas/batch/resume/e1");
  assert.equal(sellerNotice(e).uncollectedAtomic, "65");
});

test("a notice never contains the held answer", () => {
  const e = { ...entry(), ...reconcile(entry(), reserved, channelAt(100n)) };
  assert.ok(!JSON.stringify(agentNotice(e)).includes("secret-answer-text"));
  assert.ok(!JSON.stringify(sellerNotice(e)).includes("secret-answer-text"));
});

test("no answer saved: nothing is owed, and both sides are told", () => {
  const pending = entry({ answer: undefined, chargeAtomic: "0", providerCostAtomic: "0" });
  const e = { ...pending, ...reconcile(pending, reserved, channelAt(100n)) };
  assert.equal(e.status, "interrupted");
  assert.equal(canResume(e), false);
  assert.equal(agentNotice(e).answer_held, false);
  assert.match(sellerNotice(e).whatToDo, /model may still have billed/);
  assert.equal(sellerNotice(e).uncollectedAtomic, "0");
});

test("a paid-for resume that crashes is judged by its own new operation", () => {
  const resumed = entry({ status: "interrupted", operation: { channelId: "c", requestId: "new" } });
  const op: BatchOperation = { status: "completed", channelId: "c", requestId: "new", ceiling: 65n, actual: 65n, cumulative: 230n };
  assert.equal(reconcile(resumed, op, channelAt(230n)).status, "metered");
  assert.equal(reconcile(resumed, { status: "reserved", channelId: "c", requestId: "new", ceiling: 65n }, channelAt(165n)).status, "interrupted");
});

test("a per-call payment can't be judged from local records, so it's flagged and never re-billed", () => {
  const e = entry({ scheme: "upto", operation: undefined });
  const change = reconcile(e, undefined, undefined);
  assert.equal(change.status, "needs_review");
  const after = { ...e, ...change };
  assert.equal(canResume(after), false);
  assert.ok(needsAttention(after));
  assert.match(agentNotice(after).what_to_do, /Don't pay again/);
});

test("a batch entry with no operation link is flagged rather than offered for payment", () => {
  assert.equal(reconcile(entry({ operation: undefined }), undefined, undefined).status, "needs_review");
});

test("an expired held answer is no longer for sale, and the seller sees the cost it carries", () => {
  const e = entry({ status: "interrupted", operation: undefined, answer: undefined });
  assert.equal(canResume(e), false);
  assert.equal(agentNotice(e).answer_held, false);
  assert.match(sellerNotice(e).whatToDo, /carry its model cost/);
});

test("a free answer is never offered for payment", () => {
  assert.equal(canResume(entry({ status: "interrupted", chargeAtomic: "0" })), false);
});
