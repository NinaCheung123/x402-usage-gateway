/**
 * Pricing engine. All money is integer atomic units of a 6-decimal token
 * (1_000_000 atomic = 1 token). Rates are atomic units per 1M AI tokens, so a
 * rate of "3000000" means 3 payment tokens per million AI tokens.
 *
 * Each seller brings its own rate card. Rates are strings in the card so they
 * survive JSON, and bigint here so nothing is lost to rounding.
 */
export interface ModelCard {
  input: string;
  cachedInput: string;
  output: string;
  /** What the seller pays its model provider, same unit. */
  providerInput: string;
  providerCachedInput: string;
  providerOutput: string;
  maxOutputTokens: number;
  /** The provider's own model name, when it differs from the public one. */
  upstreamModel?: string;
}

export interface RateCard {
  models: Record<string, ModelCard>;
  /** A multiplier above 10_000 (1.0x) raises prices inside the window. */
  peak: { startHourUtc: number; endHourUtc: number; bps: number };
  /** Tier comes from AI tokens already billed to the wallet by this seller. */
  tiers: { name: string; minTokens: number; bps: number }[];
  /** Smallest charge for a call that delivered anything. Covers network fees. */
  minChargeAtomic: string;
}

export const DEMO_RATE_CARD: RateCard = {
  // Example names and prices, not any real company's price list.
  models: {
    "atlas-fast": {
      input: "200000",
      cachedInput: "50000",
      output: "800000",
      providerInput: "100000",
      providerCachedInput: "25000",
      providerOutput: "400000",
      maxOutputTokens: 4_000,
    },
    "atlas-pro": {
      input: "3000000",
      cachedInput: "750000",
      output: "15000000",
      providerInput: "2000000",
      providerCachedInput: "500000",
      providerOutput: "10000000",
      maxOutputTokens: 8_000,
    },
  },
  peak: { startHourUtc: 14, endHourUtc: 22, bps: 15_000 },
  tiers: [
    { name: "growth", minTokens: 5_000, bps: 8_000 },
    { name: "starter", minTokens: 0, bps: 10_000 },
  ],
  minChargeAtomic: "0",
};

const BPS = 10_000n;
const MILLION = 1_000_000n;

/** Returns what's wrong with a rate card, or null if it's usable. */
export function validateRateCard(card: RateCard | undefined): string | null {
  if (!card || typeof card !== "object") return "rate_card is required";
  const isAmount = (v: unknown) => typeof v === "string" && /^\d{1,18}$/.test(v);
  const models = Object.entries(card.models ?? {});
  if (!models.length) return "rate_card.models needs at least one model";
  for (const [id, m] of models) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) return `invalid model name: ${id}`;
    for (const f of ["input", "cachedInput", "output", "providerInput", "providerCachedInput", "providerOutput"] as const)
      if (!isAmount(m[f])) return `${id}.${f} must be a whole number string`;
    if (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens < 1 || m.maxOutputTokens > 128_000)
      return `${id}.maxOutputTokens must be 1 to 128000`;
  }
  const { startHourUtc: s, endHourUtc: e, bps } = card.peak ?? ({} as RateCard["peak"]);
  if (![s, e].every((h) => Number.isInteger(h) && h >= 0 && h <= 24) || s > e)
    return "rate_card.peak hours must run from 0 to 24, start before end";
  if (!Number.isInteger(bps) || bps < 1 || bps > 100_000) return "rate_card.peak.bps must be 1 to 100000";
  if (!card.tiers?.length) return "rate_card.tiers needs at least one tier";
  if (!card.tiers.some((t) => t.minTokens === 0)) return "rate_card.tiers needs a tier from 0 tokens";
  for (const t of card.tiers)
    if (!t.name || !Number.isInteger(t.minTokens) || t.minTokens < 0 || !Number.isInteger(t.bps) || t.bps < 1 || t.bps > 100_000)
      return "each tier needs a name, minTokens and bps";
  if (!isAmount(card.minChargeAtomic)) return "rate_card.minChargeAtomic must be a whole number string";
  return null;
}

export function isPeak(card: RateCard, at: Date): boolean {
  const h = at.getUTCHours();
  return h >= card.peak.startHourUtc && h < card.peak.endHourUtc;
}

export function tierFor(card: RateCard, tokensBilled: number) {
  const eligible = card.tiers.filter((t) => tokensBilled >= t.minTokens);
  return eligible.reduce((best, t) => (t.minTokens > best.minTokens ? t : best));
}

/** Round up so a fraction of an atomic unit is never given away. */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Conservative estimate of input tokens, used only to size the ceiling. */
export const estimateInputTokens = (prompt: string) => Math.ceil(prompt.length / 3) + 8;

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface Price {
  model: string;
  tier: string;
  period: "peak" | "off-peak";
  lines: { type: string; tokens: number; rate: string; amount: string }[];
  chargeAtomic: bigint;
  providerCostAtomic: bigint;
}

export function priceUsage(
  card: RateCard,
  model: string,
  usage: Usage,
  ctx: { at: Date; tokensBilled: number },
): Price {
  const m = card.models[model]!;
  const peak = isPeak(card, ctx.at);
  const tier = tierFor(card, ctx.tokensBilled);
  const mult = (peak ? BigInt(card.peak.bps) : BPS) * BigInt(tier.bps);
  const parts = [
    { type: "input", tokens: usage.inputTokens, rate: m.input, cost: m.providerInput },
    { type: "cached_input", tokens: usage.cachedInputTokens, rate: m.cachedInput, cost: m.providerCachedInput },
    { type: "output", tokens: usage.outputTokens, rate: m.output, cost: m.providerOutput },
  ];
  // Sum first, round once: rounding each line would overcharge small calls.
  let chargeNumerator = 0n;
  let costNumerator = 0n;
  const lines = parts.map((p) => {
    const n = BigInt(p.tokens) * BigInt(p.rate) * mult;
    chargeNumerator += n;
    costNumerator += BigInt(p.tokens) * BigInt(p.cost);
    return {
      type: p.type,
      tokens: p.tokens,
      rate: p.rate,
      // Payment tokens, for display. The charge itself uses the exact integer sum.
      amount: (Number(n) / Number(MILLION * BPS * BPS) / 1e6).toFixed(9),
    };
  });
  const delivered = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens > 0;
  const metered = ceilDiv(chargeNumerator, MILLION * BPS * BPS);
  const floor = BigInt(card.minChargeAtomic);
  return {
    model,
    tier: tier.name,
    period: peak ? "peak" : "off-peak",
    lines,
    chargeAtomic: delivered && metered < floor ? floor : metered,
    providerCostAtomic: ceilDiv(costNumerator, MILLION),
  };
}

/**
 * The most this request could cost: all input uncached, every allowed output
 * token, and the highest multipliers on the card. The real charge can only be
 * lower, so the ceiling doesn't change if the hour flips between the 402 and
 * the paid retry, or if the wallet changes tier.
 */
export function maxCharge(card: RateCard, model: string, prompt: string, maxOutputTokens: number): bigint {
  const m = card.models[model]!;
  const peak = BigInt(Math.max(card.peak.bps, 10_000));
  const tier = BigInt(Math.max(...card.tiers.map((t) => t.bps)));
  const n = (BigInt(estimateInputTokens(prompt)) * BigInt(m.input) + BigInt(maxOutputTokens) * BigInt(m.output)) * peak * tier;
  const v = ceilDiv(n, MILLION * BPS * BPS);
  const floor = BigInt(card.minChargeAtomic);
  const atLeast = floor > 1n ? floor : 1n;
  return v > atLeast ? v : atLeast;
}
