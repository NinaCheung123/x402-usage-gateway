/**
 * Local queue in front of Solana's public devnet RPC, which rate-limits hard
 * (HTTP 429). Without it, a confirmation check can fail after a transaction has
 * already landed. It spaces requests out and retries 429s. Not needed with a
 * paid RPC: leave RPC_SHIELD_URL unset and point SVM_RPC_URL at that instead.
 */
import "dotenv/config";
import { createServer } from "node:http";

const UPSTREAM = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.RPC_SHIELD_PORT ?? 8899);
const GAP_MS = 150;
const MAX_TRIES = 8;

let last: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs jobs one at a time, at least GAP_MS apart. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = last.then(async () => {
    await sleep(GAP_MS);
    return job();
  });
  last = run.catch(() => undefined);
  return run;
}

async function forward(body: string) {
  for (let attempt = 1; ; attempt++) {
    const r = await enqueue(() =>
      fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
    if (r.status !== 429 || attempt >= MAX_TRIES) return r;
    const wait = Number(r.headers.get("retry-after") ?? 0) * 1000 || 500 * 2 ** (attempt - 1);
    console.log(`[rpc-shield] 429, retry ${attempt} in ${wait} ms`);
    await sleep(wait);
  }
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    try {
      const upstream = await forward(Buffer.concat(chunks).toString());
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(await upstream.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : "upstream error" }));
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`rpc shield on http://localhost:${PORT} -> ${UPSTREAM}`));
