/**
 * Estimated network fees. The payment token has no live price against SOL here,
 * so this uses a SOL price the seller chooses, in payment tokens. It leaves out
 * account rent, which comes back when channels close, and infrastructure.
 */
const ATOMIC_PER_TOKEN = 1_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Measured on devnet. Mainnet priority fees could be higher. */
export const DEFAULT_LAMPORTS_PER_TX = 10_001;
export const DEFAULT_SOL_PRICE_TOKENS = 150;

export interface FeeAssumptions {
  lamportsPerTx: number;
  solPriceTokens: number;
}

export function feeAssumptions(env: NodeJS.ProcessEnv = process.env): FeeAssumptions {
  const number = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    lamportsPerTx: number(env.ASSUMED_LAMPORTS_PER_TX, DEFAULT_LAMPORTS_PER_TX),
    solPriceTokens: number(env.ASSUMED_SOL_PRICE, DEFAULT_SOL_PRICE_TOKENS),
  };
}

/** Rounds up, so an estimate never makes a sale look better than it was. */
export function networkCostAtomic(transactions: number, a: FeeAssumptions): bigint {
  const price = BigInt(Math.round(a.solPriceTokens * Number(ATOMIC_PER_TOKEN)));
  const n = BigInt(transactions) * BigInt(Math.round(a.lamportsPerTx)) * price;
  return (n + LAMPORTS_PER_SOL - 1n) / LAMPORTS_PER_SOL;
}

/** A batch channel opens once and closes once, whatever happens in between. */
export const BATCH_CHANNEL_TX = 2;
/** A per-call payment locks once and settles once. */
export const PER_CALL_TX = 2;
