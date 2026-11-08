/**
 * Sellers registered with the gateway. A seller brings a wallet, a rate card
 * and a model source; the gateway handles payment, metering and the ledger.
 */
import { PublicKey } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRateCard, type RateCard } from "./pricing.js";

export type ProviderConfig =
  | { type: "simulated" }
  /** The seller's own model endpoint. See HttpProvider for its contract. */
  | { type: "http"; url: string }
  /** Claude, using the credentials in this gateway's environment. */
  | { type: "anthropic" };

export interface Seller {
  id: string;
  name: string;
  payTo: string;
  provider: ProviderConfig;
  rateCard: RateCard;
  createdAt: string;
}

/** Returns what's wrong with a seller registration, or null if it's usable. */
export function validateSeller(body: Partial<Seller> | undefined): string | null {
  if (!body) return "body is required";
  if (typeof body.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(body.id))
    return "id must be 2 to 40 lowercase letters, numbers or hyphens";
  if (typeof body.name !== "string" || !body.name.trim()) return "name is required";
  try {
    if (typeof body.payTo !== "string" || new PublicKey(body.payTo).toBase58() !== body.payTo) throw new Error();
  } catch {
    return "payTo must be a Solana address";
  }
  const p = body.provider;
  if (p?.type === "http") {
    try {
      if (!/^https?:$/.test(new URL(p.url).protocol)) throw new Error();
    } catch {
      return "provider.url must be an http or https URL";
    }
  } else if (p?.type !== "simulated" && p?.type !== "anthropic") {
    return "provider.type must be simulated, http or anthropic";
  }
  return validateRateCard(body.rateCard);
}

export class SellerRegistry {
  private sellers = new Map<string, Seller>();

  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const s of JSON.parse(readFileSync(path, "utf8")) as Seller[]) this.sellers.set(s.id, s);
  }

  get = (id: string) => this.sellers.get(id);
  all = () => [...this.sellers.values()];

  /** Adds a seller or replaces its settings. New prices apply to new calls only. */
  upsert(s: Omit<Seller, "createdAt">): Seller {
    const saved: Seller = { ...s, createdAt: this.sellers.get(s.id)?.createdAt ?? new Date().toISOString() };
    this.sellers.set(s.id, saved);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path);
    return saved;
  }
}
