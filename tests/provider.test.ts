import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { AnthropicProvider, HttpProvider, ProviderError, requireText } from "../src/provider.js";

const servers: ReturnType<typeof createServer>[] = [];
after(() => servers.forEach((s) => s.close()));

/** A local stand-in endpoint. These tests never call a real service or spend money. */
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}
const json = (body: unknown, status = 200): RequestListener => (req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
};
const req = { model: "m", prompt: "hello", maxOutputTokens: 50 };

test("seller endpoint: reads text and usage", async () => {
  const url = await serve(json({ text: "hi", usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 9 } }));
  const r = await new HttpProvider(url).generate(req);
  assert.deepEqual(r.usage, { inputTokens: 5, cachedInputTokens: 2, outputTokens: 9 });
  assert.equal(r.delivered, "full");
});

test("seller endpoint: truncated flag means truncated", async () => {
  const url = await serve(json({ text: "h", truncated: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal((await new HttpProvider(url).generate(req)).delivered, "truncated");
});

for (const [name, handler] of [
  ["error status", json({ error: "x" }, 500)],
  ["negative usage", json({ text: "x", usage: { input_tokens: -1, output_tokens: 1 } })],
  ["missing usage", json({ text: "x" })],
  ["missing text", json({ usage: { input_tokens: 1, output_tokens: 1 } })],
] as const) {
  test(`seller endpoint: ${name} fails, so the caller isn't charged`, async () => {
    const url = await serve(handler);
    await assert.rejects(new HttpProvider(url).generate(req), ProviderError);
  });
}

test("seller endpoint: unreachable fails, so the caller isn't charged", async () => {
  await assert.rejects(new HttpProvider("http://localhost:1").generate(req), ProviderError);
});

const message = (over: object) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Hi there" }],
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
  ...over,
});
const claude = (baseURL: string) =>
  new AnthropicProvider(new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 }));

test("Claude: maps text and all token types through the real SDK", async () => {
  let sent: Record<string, unknown> = {};
  const url = await serve((rq, res) => {
    let b = "";
    rq.on("data", (c) => (b += c));
    rq.on("end", () => {
      sent = JSON.parse(b) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message({})));
    });
  });
  const r = await claude(url).generate({ ...req, model: "claude-opus-5-5" });
  assert.equal(r.text, "Hi there");
  assert.deepEqual(r.usage, { inputTokens: 13, cachedInputTokens: 7, outputTokens: 20 });
  assert.equal(r.delivered, "full");
  assert.equal(sent.max_tokens, 50);
  assert.equal(sent.model, "claude-opus-5-5");
});

test("Claude: hitting max_tokens counts as truncated", async () => {
  const url = await serve(json(message({ stop_reason: "max_tokens" })));
  assert.equal((await claude(url).generate(req)).delivered, "truncated");
});

test("Claude: a refusal fails, so the caller isn't charged", async () => {
  const url = await serve(json(message({ stop_reason: "refusal", content: [] })));
  await assert.rejects(claude(url).generate(req), ProviderError);
});

test("Claude: an API error fails, so the caller isn't charged", async () => {
  const url = await serve(json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529));
  await assert.rejects(claude(url).generate(req), ProviderError);
});

test("an answer with no text fails, keeping what it cost the seller", async () => {
  const url = await serve(json(message({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "", signature: "s" }] })));
  const result = await claude(url).generate(req);
  assert.equal(result.delivered, "truncated");
  assert.throws(() => requireText(result), (e: unknown) => e instanceof ProviderError && e.usage?.outputTokens === 20);
});

test("an answer with text passes", () => {
  const result = { text: "hi", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, delivered: "full" as const };
  assert.equal(requireText(result), result);
});
