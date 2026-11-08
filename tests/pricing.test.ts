import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_RATE_CARD as CARD, maxCharge, priceUsage, tierFor, validateRateCard } from "../src/pricing.js";

const OFF_PEAK = new Date("2026-11-08T03:00:00Z");
const PEAK = new Date("2026-11-08T15:00:00Z");
const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 };

test("charges by token type at off-peak list price", () => {
  // atlas-pro: 1000 × 3 + 1000 × 15 atomic = 18,000
  const p = priceUsage(CARD, "atlas-pro", usage, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(p.chargeAtomic, 18_000n);
  assert.equal(p.providerCostAtomic, 12_000n);
  assert.equal(p.period, "off-peak");
  assert.equal(p.tier, "starter");
});

test("cached input is cheaper than fresh input", () => {
  const cached = priceUsage(CARD, "atlas-pro", { inputTokens: 0, cachedInputTokens: 1000, outputTokens: 0 }, { at: OFF_PEAK, tokensBilled: 0 });
  const fresh = priceUsage(CARD, "atlas-pro", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(cached.chargeAtomic, 750n);
  assert.equal(fresh.chargeAtomic, 3_000n);
});

test("peak adds 50%", () => {
  const p = priceUsage(CARD, "atlas-pro", usage, { at: PEAK, tokensBilled: 0 });
  assert.equal(p.chargeAtomic, 27_000n);
  assert.equal(p.period, "peak");
});

test("growth tier takes 20% off and combines with peak", () => {
  const off = priceUsage(CARD, "atlas-pro", usage, { at: OFF_PEAK, tokensBilled: 5_000 });
  assert.equal(off.chargeAtomic, 14_400n);
  assert.equal(off.tier, "growth");
  const peak = priceUsage(CARD, "atlas-pro", usage, { at: PEAK, tokensBilled: 5_000 });
  assert.equal(peak.chargeAtomic, 21_600n);
});

test("tier boundary is inclusive", () => {
  assert.equal(tierFor(CARD, 4_999).name, "starter");
  assert.equal(tierFor(CARD, 5_000).name, "growth");
});

test("fractions round up once, on the total", () => {
  // atlas-fast input is 0.2 atomic per token. 3 tokens = 0.6, charged as 1.
  const p = priceUsage(CARD, "atlas-fast", { inputTokens: 3, cachedInputTokens: 0, outputTokens: 0 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(p.chargeAtomic, 1n);
  // 3 + 2 tokens at 0.2 = exactly 1. Per-line rounding would give 2.
  const q = priceUsage(CARD, "atlas-fast", { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(q.chargeAtomic, 1n);
});

test("zero usage costs zero", () => {
  const p = priceUsage(CARD, "atlas-fast", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, { at: PEAK, tokensBilled: 0 });
  assert.equal(p.chargeAtomic, 0n);
});

test("the ceiling covers the worst real charge at any hour", () => {
  const prompt = "x".repeat(900); // estimate is 308 tokens, of which 300 are billed
  const ceiling = maxCharge(CARD, "atlas-pro", prompt, 500);
  const worst = priceUsage(CARD, "atlas-pro", { inputTokens: 300, cachedInputTokens: 0, outputTokens: 500 }, { at: PEAK, tokensBilled: 0 });
  assert.ok(worst.chargeAtomic <= ceiling, `${worst.chargeAtomic} > ${ceiling}`);
});

test("the ceiling is never zero", () => {
  assert.ok(maxCharge(CARD, "atlas-fast", "", 1) >= 1n);
});

test("a minimum charge applies when anything was delivered, never to nothing", () => {
  const card = { ...CARD, minChargeAtomic: "3000" };
  const small = priceUsage(card, "atlas-fast", { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(small.chargeAtomic, 3_000n);
  const none = priceUsage(card, "atlas-fast", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.equal(none.chargeAtomic, 0n);
  assert.ok(maxCharge(card, "atlas-fast", "x", 1) >= 3_000n);
});

test("the ceiling covers a card whose tiers charge more than list price", () => {
  const card = { ...CARD, tiers: [{ name: "premium", minTokens: 0, bps: 20_000 }] };
  const worst = priceUsage(card, "atlas-pro", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 500 }, { at: PEAK, tokensBilled: 0 });
  assert.ok(worst.chargeAtomic <= maxCharge(card, "atlas-pro", "x".repeat(300), 500));
});

test("the ceiling ignores a discount window, so it never falls below off-peak", () => {
  const card = { ...CARD, peak: { startHourUtc: 14, endHourUtc: 22, bps: 5_000 } };
  const offPeak = priceUsage(card, "atlas-pro", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 500 }, { at: OFF_PEAK, tokensBilled: 0 });
  assert.ok(offPeak.chargeAtomic <= maxCharge(card, "atlas-pro", "x".repeat(300), 500));
});

test("rate cards are validated", () => {
  assert.equal(validateRateCard(CARD), null);
  assert.ok(validateRateCard({ ...CARD, models: {} }));
  assert.ok(validateRateCard({ ...CARD, minChargeAtomic: "-1" }));
  assert.ok(validateRateCard({ ...CARD, peak: { startHourUtc: 22, endHourUtc: 14, bps: 15_000 } }));
  assert.ok(validateRateCard({ ...CARD, tiers: [{ name: "x", minTokens: 100, bps: 10_000 }] }));
});
