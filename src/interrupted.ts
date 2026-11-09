/**
 * What happens to a call the gateway was killed in the middle of.
 *
 * A batch charge is recorded in three places, and a crash can fall between any
 * of them: the ledger, the single-use operation record, then the channel. After
 * a restart these work out what really happened, and neither side is left guessing:
 *
 *   Charged, not recorded   The ledger catches up. The answer is free to collect.
 *   Answer held, no charge  The agent can pay the original price to collect it,
 *                           without the model running again. Paying is its choice.
 *   No answer, no charge    The agent sends a new request. The seller is told,
 *                           because its model may have billed it anyway.
 *
 * A per-call payment settles on-chain through the facilitator, so the gateway
 * can't tell from its own records whether money moved. That case is flagged for
 * review and is never billed again.
 */
import type { BatchOperation, ChannelState } from "@x402/svm/batch-settlement/server";
import type { Entry } from "./ledger.js";

export interface OperationLink {
  channelId: string;
  requestId: string;
}

/** The IDs that tie a batch payment proof to its operation record. */
export function operationLink(payload: unknown): OperationLink | undefined {
  const authorization = (payload as { authorization?: Partial<OperationLink> } | undefined)?.authorization;
  const { channelId, requestId } = authorization ?? {};
  return typeof channelId === "string" && typeof requestId === "string" ? { channelId, requestId } : undefined;
}

/**
 * Decides what an unfinished call's ledger entry should become after a restart.
 *
 * A completed operation only counts as a charge if the channel shows it too: x402
 * writes the operation first, so a crash can leave it completed but not charged.
 * The link is cleared unless the charge is confirmed, because later charges on
 * the channel would make this comparison wrongly succeed at the next restart.
 */
export function reconcile(
  entry: Entry,
  operation: BatchOperation | undefined,
  channel: ChannelState | undefined,
): Partial<Entry> {
  if (entry.scheme !== "batch-settlement" || !entry.operation) {
    return {
      status: "needs_review",
      reason: "Gateway crashed mid-call, so the outcome is unknown. Check the seller's wallet.",
    };
  }
  if (operation?.status === "completed" && channel && channel.chargedCumulativeAmount >= operation.cumulative) {
    return {
      status: "metered",
      chargeAtomic: operation.actual.toString(),
      reason: "Gateway crashed after charging. The ledger caught up from the channel record.",
    };
  }
  return entry.answer !== undefined
    ? { status: "interrupted", operation: undefined, reason: "Gateway crashed before charging. The answer is held for the agent to collect." }
    : { status: "interrupted", operation: undefined, chargeAtomic: "0", reason: "Gateway crashed before an answer was saved. Nobody was charged." };
}

/** Calls where someone still has a decision to make or something to check. */
export const needsAttention = (e: Entry) => e.status === "interrupted" || e.status === "needs_review";

export const canResume = (e: Entry) =>
  e.status === "interrupted" && e.scheme === "batch-settlement" && e.answer !== undefined && BigInt(e.chargeAtomic) > 0n;

/** What the agent is told when it asks about an interrupted call. */
export function agentNotice(e: Entry) {
  if (e.status === "needs_review") {
    return {
      status: e.status,
      receipt_url: `/v1/receipts/${e.id}`,
      what_happened: "The gateway crashed during this call, so it can't tell whether your payment settled.",
      what_to_do: "Don't pay again for this proof. Check your wallet: funds that were only locked come back through channel cleanup. If you were charged and have no answer, send the seller this receipt.",
    };
  }
  if (canResume(e)) {
    return {
      status: e.status,
      charged_atomic: "0",
      answer_held: true,
      price_atomic: e.chargeAtomic,
      resume_url: `/s/${encodeURIComponent(e.sellerId!)}/batch/resume/${e.id}`,
      receipt_url: `/v1/receipts/${e.id}`,
      what_happened: "The gateway crashed after your answer was ready but before charging you. You have not been charged.",
      what_to_do: "To get this answer, POST to resume_url and pay price_atomic through the usual 402. The model won't run again. If you no longer want it, do nothing and you won't be charged.",
    };
  }
  return {
    status: e.status,
    charged_atomic: "0",
    answer_held: false,
    receipt_url: `/v1/receipts/${e.id}`,
    what_happened: "The gateway crashed during this call and no answer is available. You have not been charged.",
    what_to_do: "Send a new request with a new payment proof.",
  };
}

/** What the seller sees on its dashboard for an interrupted call. */
export function sellerNotice(e: Entry) {
  const base = {
    id: e.id,
    at: e.at,
    status: e.status,
    sellerId: e.sellerId,
    payer: e.payer,
    modelCostAtomic: e.providerCostAtomic,
  };
  if (e.status === "needs_review") {
    return { ...base, uncollectedAtomic: "0", answerHeld: false, whatToDo: "Compare this call with your wallet. The chain shows whether the payment settled." };
  }
  if (canResume(e)) {
    return { ...base, uncollectedAtomic: e.chargeAtomic, answerHeld: true, whatToDo: "Nothing yet. You're paid if the agent chooses to collect the answer. Until then this charge is uncollected." };
  }
  return {
    ...base,
    uncollectedAtomic: "0",
    answerHeld: false,
    whatToDo: BigInt(e.providerCostAtomic) > 0n
      ? "The agent didn't collect this answer before it expired, so you carry its model cost."
      : "No answer was saved, so the agent wasn't charged. Your model may still have billed you: check its usage for this time.",
  };
}
