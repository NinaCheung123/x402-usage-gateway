/**
 * Model sources behind the gateway. Each returns text and token counts, or
 * throws ProviderError, which refunds the caller.
 */
import Anthropic from "@anthropic-ai/sdk";
import { estimateInputTokens, type Usage } from "./pricing.js";
import type { ProviderConfig } from "./sellers.js";

export type Failure = "provider_error" | "truncated" | "overrun";

export interface ProviderRequest {
  /** Sent to the source: the card's upstream name, or else the public name. */
  model: string;
  prompt: string;
  maxOutputTokens: number;
  failure?: Failure;
}

export interface ProviderResult {
  text: string;
  usage: Usage;
  delivered: "full" | "truncated";
}

export interface Provider {
  generate(req: ProviderRequest): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  /** Set when the provider did work, and so charged the seller, but delivered nothing. */
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

/**
 * An answer with no text isn't worth charging for, whatever it consumed. This
 * can happen with Claude, whose thinking counts toward max_tokens and can't be
 * turned off: a small limit can be used up before any text is written.
 */
export function requireText(result: ProviderResult): ProviderResult {
  if (!result.text.trim()) throw new ProviderError("the model returned no text", result.usage);
  return result;
}

/** No API key needed; failures can be triggered on demand for the demo. */
export class SimulatedProvider implements Provider {
  private seen = new Set<string>();

  async generate({ model, prompt, maxOutputTokens, failure }: ProviderRequest): Promise<ProviderResult> {
    if (failure === "provider_error") throw new ProviderError("simulated provider outage");

    // Repeating a prompt reads most of it from cache, like real prompt caching.
    const total = Math.max(1, estimateInputTokens(prompt) - 8);
    const cachedInputTokens = this.seen.has(prompt) ? Math.floor(total * 0.8) : 0;
    this.seen.add(prompt);
    const usage = { inputTokens: total - cachedInputTokens, cachedInputTokens, outputTokens: 0 };

    // Output scales with the prompt, so it's usually far below the allowed maximum.
    const natural = Math.min(maxOutputTokens, 60 + total * 4);
    if (failure === "truncated") {
      usage.outputTokens = Math.max(1, Math.floor(natural / 3));
      return { text: `[${model}] partial answer…`, usage, delivered: "truncated" };
    }
    if (failure === "overrun") {
      usage.outputTokens = maxOutputTokens * 3;
      return { text: `[${model}] answer longer than allowed`, usage, delivered: "full" };
    }
    usage.outputTokens = natural;
    return { text: `[${model}] simulated answer to: ${prompt.slice(0, 60)}`, usage, delivered: "full" };
  }
}

/**
 * The seller's own model endpoint.
 * Request: POST { model, prompt, max_output_tokens }
 * Response: { text, usage: { input_tokens, cached_input_tokens, output_tokens }, truncated? }
 * A bad status or unreadable usage counts as failed, so the caller isn't charged.
 */
export class HttpProvider implements Provider {
  constructor(private url: string) {}

  async generate({ model, prompt, maxOutputTokens }: ProviderRequest): Promise<ProviderResult> {
    let r: Response;
    try {
      r = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, max_output_tokens: maxOutputTokens }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw new ProviderError(`seller endpoint unreachable: ${e instanceof Error ? e.message : e}`);
    }
    if (!r.ok) throw new ProviderError(`seller endpoint returned ${r.status}`);
    let b: { text?: unknown; truncated?: unknown; usage?: Record<string, unknown> };
    try {
      b = (await r.json()) as typeof b;
    } catch {
      throw new ProviderError("seller endpoint returned unreadable JSON");
    }
    const count = (v: unknown) => (v === undefined ? 0 : v);
    const nums = [b.usage?.input_tokens, count(b.usage?.cached_input_tokens), b.usage?.output_tokens];
    if (typeof b.text !== "string" || !nums.every((n) => Number.isInteger(n) && (n as number) >= 0))
      throw new ProviderError("seller endpoint returned no text or invalid usage");
    const [inputTokens, cachedInputTokens, outputTokens] = nums as [number, number, number];
    return {
      text: b.text,
      usage: { inputTokens, cachedInputTokens, outputTokens },
      delivered: b.truncated === true ? "truncated" : "full",
    };
  }
}

/** Claude through the official SDK, using the gateway's environment credentials. */
export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async generate({ model, prompt, maxOutputTokens }: ProviderRequest): Promise<ProviderResult> {
    let res;
    try {
      res = await this.client.beta.messages.create({
        model,
        max_tokens: maxOutputTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: prompt }],
        // Must finish inside the 120-second payment window, or the settlement
        // fails after the seller has already paid for the answer. No retries,
        // because each one would use up the same window.
      } as never, { timeout: 100_000, maxRetries: 0 });
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new ProviderError(`Claude API error ${e.status ?? "connection"}: ${e.message}`);
      throw e;
    }
    const msg = res as unknown as Anthropic.Beta.BetaMessage;
    if (msg.stop_reason === "refusal") throw new ProviderError("the model declined this request");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const u = msg.usage;
    return {
      text,
      usage: {
        // Cache writes bill the customer as input. The provider charges them
        // somewhat more, which isn't modelled in the seller's margin here.
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens,
      },
      delivered: msg.stop_reason === "max_tokens" ? "truncated" : "full",
    };
  }
}

const simulated = new SimulatedProvider();
let anthropic: AnthropicProvider | undefined;

export function providerFor(config: ProviderConfig): Provider {
  if (config.type === "http") return new HttpProvider(config.url);
  if (config.type === "anthropic") return (anthropic ??= new AnthropicProvider());
  return simulated;
}
