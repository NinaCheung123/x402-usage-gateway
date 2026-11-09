/**
 * Guided seller setup: asks for a wallet, a model and prices, registers the
 * seller, and checks that its endpoint is ready to take payment. Prices are in
 * payment tokens per million AI tokens. Needs the gateway running.
 * Any answer can be passed as a flag, such as --id, --wallet or --input.
 */
import { base58 } from "@scure/base";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import "dotenv/config";
import { createInterface } from "node:readline/promises";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4021";
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const noPrompt = args.includes("--no-prompt");
const rl = noPrompt ? undefined : createInterface({ input: process.stdin, output: process.stdout });

async function ask(name: string, question: string, fallback?: string) {
  const given = flag(name);
  if (given !== undefined) return given;
  if (!rl) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required with --no-prompt`);
  }
  const hint = fallback ? ` [${fallback}]` : "";
  return (await rl.question(`${question}${hint}: `)).trim() || fallback || "";
}

/** "1.5" payment tokens becomes "1500000" atomic units, without float rounding. */
function atomic(value: string, label: string) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!m) throw new Error(`${label} must be a number with up to 6 decimals, not "${value}"`);
  return (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

try {
  const id = await ask("id", "Seller ID (lowercase letters, numbers, hyphens)");
  const name = await ask("name", "Display name", id);
  const wallet = await ask("wallet", "Wallet that receives payments");
  const endpoint = await ask("endpoint", "Your model endpoint URL (blank to use the simulated one)", "");
  const model = await ask("model", "Model name", "my-model");
  const input = atomic(await ask("input", "Price per 1M input tokens", "1"), "input price");
  const cached = atomic(await ask("cached", "Price per 1M cached input tokens", (Number(input) / 1e6).toString()), "cached price");
  const output = atomic(await ask("output", "Price per 1M output tokens", "4"), "output price");
  const costInput = atomic(await ask("cost-input", "Your cost per 1M input tokens", "0"), "input cost");
  const costOutput = atomic(await ask("cost-output", "Your cost per 1M output tokens", "0"), "output cost");
  const min = atomic(await ask("min", "Minimum charge per call", "0.001"), "minimum charge");
  const maxOutput = Number(await ask("max-output", "Most output tokens per call", "4000"));
  rl?.close();

  // Settlement needs a token account for the wallet, so create it if it's missing.
  const payer = Keypair.fromSecretKey(base58.decode(process.env.FACILITATOR_KEY!.trim()));
  const conn = new Connection(process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  await getOrCreateAssociatedTokenAccount(conn, payer, new PublicKey(process.env.TEST_MINT!), new PublicKey(wallet));

  const res = await fetch(`${GATEWAY}/admin/sellers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    body: JSON.stringify({
      id,
      name,
      payTo: wallet,
      provider: endpoint ? { type: "http", url: endpoint } : { type: "simulated" },
      rateCard: {
        models: {
          [model]: { input, cachedInput: cached, output, providerInput: costInput, providerCachedInput: costInput, providerOutput: costOutput, maxOutputTokens: maxOutput },
        },
        peak: { startHourUtc: 0, endHourUtc: 0, bps: 10_000 },
        tiers: [{ name: "standard", minTokens: 0, bps: 10_000 }],
        minChargeAtomic: min,
      },
    }),
  });
  const body = (await res.json()) as { message?: string; endpoints?: Record<string, string> };
  if (res.status !== 201) throw new Error(body.message ?? `registration returned ${res.status}`);

  const probe = await fetch(`${GATEWAY}/s/${id}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "hello", max_output_tokens: 10 }),
  });
  if (probe.status !== 402) throw new Error(`expected the endpoint to ask for payment, got ${probe.status}`);

  console.log(`\n${name} can now take payment.`);
  for (const [label, path] of Object.entries(body.endpoints ?? {})) console.log(`  ${label}: ${GATEWAY}${path}`);
  console.log(`  dashboard: ${GATEWAY}/ (choose "${name}")`);
} catch (e) {
  rl?.close();
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
