/**
 * Append-only usage ledger stored as JSON lines. Each change appends a full
 * record; the newest record for an id wins when the file is read back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Price, Usage } from "./pricing.js";

export type Scheme = "upto" | "batch-settlement";

export type Status =
  | "pending" // answer produced, settlement not confirmed yet
  | "settled" // upto: on-chain now, seller paid and the rest returned
  | "metered" // batch: charged to the channel, the seller claims it in a batch
  | "refunded" // provider failed or delivered nothing; caller wasn't charged
  | "refund_pending" // not charged, but the refund failed; channel cleanup returns the funds
  | "needs_review" // settlement outcome lost, e.g. a crash mid-call; check the chain
  | "interrupted" // the gateway crashed before charging; see src/interrupted.ts
  | "settle_failed" // settlement failed; seller absorbs the model cost
  | "rejected"; // payment refused before any work started

export interface Entry {
  id: string;
  at: string;
  status: Status;
  sellerId?: string;
  scheme?: Scheme;
  payer?: string;
  model?: string;
  usage?: Usage;
  tier?: string;
  period?: string;
  lines?: Price["lines"];
  authorizedAtomic?: string;
  chargeAtomic: string;
  providerCostAtomic: string;
  /** Usage above the ceiling that couldn't be billed. */
  unbilledAtomic?: string;
  delivered?: "full" | "truncated" | "none";
  tx?: string;
  reason?: string;
  /** Kept briefly, so a caller whose response was lost can collect it without paying again. */
  answer?: unknown;
  /** Hash of the payment proof, which lets its holder recover the answer. */
  proofHash?: string;
  /** The batch operation behind this call, which shows whether it was charged. */
  operation?: { channelId: string; requestId: string };
}

const earned = (e: Entry) => e.status === "settled" || e.status === "metered";

export class Ledger {
  private entries = new Map<string, Entry>();

  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry;
        this.entries.set(e.id, e);
      } catch {
        // A crash can leave a half-written line. The seller's money isn't held
        // here, so one bad record must not stop the gateway from starting.
        console.warn(`[ledger] skipped an unreadable line in ${path}`);
      }
    }
    // Otherwise the next record would be glued onto the half-written line.
    if (text && !text.endsWith("\n")) appendFileSync(path, "\n");
  }

  put(entry: Entry) {
    this.entries.set(entry.id, entry);
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  update(id: string, change: Partial<Entry>) {
    const e = this.entries.get(id);
    if (e) this.put({ ...e, ...change });
  }

  get = (id: string) => this.entries.get(id);

  findByProof(proofHash: string) {
    for (const e of this.entries.values()) if (e.proofHash === proofHash) return e;
    return undefined;
  }

  /** Answers are customer data, so they're only kept long enough to recover. */
  forgetAnswersBefore(cutoff: number) {
    for (const e of this.entries.values())
      if (e.answer !== undefined && e.status !== "pending" && Date.parse(e.at) < cutoff) this.update(e.id, { answer: undefined });
  }

  all = () => [...this.entries.values()].sort((a, b) => b.at.localeCompare(a.at));

  /** AI tokens this seller has billed the wallet; decides its tier. */
  tokensBilled(sellerId: string, payer: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.sellerId !== sellerId || e.payer !== payer || !earned(e) || !e.usage) continue;
      n += e.usage.inputTokens + e.usage.cachedInputTokens + e.usage.outputTokens;
    }
    return n;
  }

  /** Calls whose lock reached the chain, so they paid network fees either way. */
  perCallsOnChain(sellerId?: string) {
    const onChain: Status[] = ["settled", "refunded", "refund_pending", "settle_failed"];
    return this.all().filter((e) => e.scheme === "upto" && onChain.includes(e.status) && (!sellerId || e.sellerId === sellerId)).length;
  }

  stats(sellerId?: string) {
    const all = this.all().filter((e) => !sellerId || e.sellerId === sellerId);
    const sum = (rows: Entry[], f: (e: Entry) => string | undefined) =>
      rows.reduce((t, e) => t + BigInt(f(e) ?? "0"), 0n);
    const paid = all.filter(earned);
    // Model cost counts whenever the provider did work, even if the caller paid nothing.
    const costed = all.filter((e) => BigInt(e.providerCostAtomic) > 0n);
    const revenue = sum(paid, (e) => e.chargeAtomic);
    const cost = sum(costed, (e) => e.providerCostAtomic);
    const counts: Record<string, number> = {};
    for (const e of all) counts[e.status] = (counts[e.status] ?? 0) + 1;
    const group = (key: (e: Entry) => string | undefined) => {
      const out: Record<string, { calls: number; revenue: string; cost: string; margin: string }> = {};
      for (const k of new Set(paid.map(key))) {
        if (!k) continue;
        const rows = paid.filter((e) => key(e) === k);
        const r = sum(rows, (e) => e.chargeAtomic);
        const c = sum(rows, (e) => e.providerCostAtomic);
        out[k] = { calls: rows.length, revenue: r.toString(), cost: c.toString(), margin: (r - c).toString() };
      }
      return out;
    };
    return {
      revenueAtomic: revenue.toString(),
      modelCostAtomic: cost.toString(),
      marginAtomic: (revenue - cost).toString(),
      unbilledAtomic: sum(all, (e) => e.unbilledAtomic).toString(),
      counts,
      byModel: group((e) => e.model),
      byScheme: group((e) => e.scheme),
    };
  }
}
