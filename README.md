# x402 Usage Gateway

Usage-based billing for AI APIs, with no accounts. An AI agent pays through x402 on Solana and is charged only for what it actually used. A seller registers a wallet, a rate card and a model source, and gets metering, settlement, refunds, a ledger and a margin view without building billing.

Plain explanation in English and Chinese / 中英文说明: [docs/IDEA.md](docs/IDEA.md)

## How an agent pays

There are two ways to pay. Both use the same pricing, ledger and failure handling.

| | Per call (`upto`) | Batch (`batch-settlement`) |
|---|---|---|
| **Suits** | A one-off caller that doesn't trust the seller | A repeat caller |
| **Funds** | Locks each call's maximum | One deposit covers many calls |
| **On-chain** | 2 transactions per call | Open once, claim in batches, close once |
| **Measured speed** | About 4 seconds per call | Median about 190 ms after the first call |
| **Who enforces the limit** | The chain enforces each call's ceiling | The agent caps its deposit and chooses which operators to trust |

The steps for one per-call payment:

1. The agent calls `POST /s/:seller/generate` with no account and receives `402 Payment Required` with the most this request could cost.
2. It locks that maximum in a Solana payment channel.
3. The gateway runs the seller's model and prices the delivered tokens by model, token type, customer tier and time of day.
4. The seller receives the actual charge, and the rest returns to the agent in the same settlement.
5. The agent gets a usage record. The seller's dashboard shows revenue, model cost and margin.

## How a seller joins

Replace `payTo` in the example with the seller's wallet, then register from the project folder. `ADMIN_TOKEN` is in `.env`, and the wallet needs a token account for the payment token.

```bash
set -a; source .env; set +a; curl -X POST http://localhost:4021/admin/sellers -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d @examples/seller-simulated.json
```

The seller provides a wallet, a rate card and one model source:

| `provider.type` | Model source | Status |
|---|---|---|
| `simulated` | Built-in test provider, no key needed | Tested on devnet |
| `http` | The seller's own endpoint | Tested on devnet |
| `anthropic` | Claude, using the gateway's credentials | Tested against a local stand-in only. **Not yet run against the live API** |

An `http` endpoint receives `{ model, prompt, max_output_tokens }` and returns `{ text, usage: { input_tokens, cached_input_tokens, output_tokens }, truncated? }`. If the endpoint is down, its usage can't be read or the answer has no text, the agent isn't charged.

The `anthropic` adapter sends `fallbacks: "default"`, so if Claude declines a request the API can retry it on a fallback model. The seller's rate card doesn't change when that happens. See [examples/seller-claude.json](examples/seller-claude.json).

## How Solana powers it

- **Enforced ceiling:** the payment-channel programme holds the funds, and a per-call seller can't settle above the lock.
- **Variable charge:** the final amount is decided after the work, which is what token pricing needs.
- **Batching:** the agent deposits once and off-chain vouchers track the running total, so small calls don't each pay network fees.
- **Agents don't need SOL:** the facilitator sponsors transaction fees and account rent.
- **No account:** the wallet is the agent's only identity, and it also decides its pricing tier.

## Run it

Needs Node.js 20 or newer (tested on 26).

```bash
npm install
```

```bash
npm run setup
```

The first `setup` creates throwaway devnet wallets in `.env`, then stops and asks for test SOL. Send SOL to the facilitator address it prints using [faucet.solana.com](https://faucet.solana.com), then run `npm run setup` again.

Start the services in normal mode:

```bash
npm start
```

Or, to run the demo, start them in demo mode. It turns on the switches the demo uses to cause failures on purpose, so don't expose it to anyone else.

```bash
npm run start:demo
```

Then run the demo in a second terminal:

```bash
npm run demo
```

Open the dashboard at <http://localhost:4021/>. Everything listens on this machine only. To serve agents directly, set `GATEWAY_HOST`.

The crash test starts its own services and takes several minutes, so stop the others first:

```bash
npm run crash-test
```

Run the unit tests with:

```bash
npm test
```

To reset the numbers, stop the services and delete `data/ledger.jsonl`. Keep the other files in `data/`: they hold open channels and unclaimed seller money.

## What's tested

`npm run demo` makes real devnet payments and checks money movements against on-chain balances, not the gateway's own numbers. It exits with an error if any check fails.

| # | Scenario | Expected result |
|---|---|---|
| 1 | Invalid request or unknown seller | `400` or `404` before anyone locks money |
| 2 | No payment, or a rewritten path | `402` with the ceiling; no money moves and no free answer |
| 3 | Normal call | Agent pays and seller receives exactly the charge |
| 3b | Agent hangs up mid-call | The charge still lands and the ledger records it |
| 4 | Repeated prompt | Cached input makes it cheaper |
| 5 | AI provider fails after the lock | `502`; agent loses nothing |
| 6 | Answer cut off | Charged only for delivered tokens |
| 7 | Provider exceeds the limit | Charge stops at the ceiling; seller's loss recorded |
| 8 | Reused payment proof | Rejected; the AI model never runs |
| 9 | Wallet has no funds | Clear error; no work starts |
| 10 | Quote exceeds the agent's limit | x402 client refuses; agent switches to a cheaper model |
| 11 | Payment lands but can't be confirmed | Agent collects the answer later; charged once |
| 12 | Repeat caller | One deposit; seller's claim equals the sum of charges; agent's net cost equals the charges after refund; replayed proofs and empty wallets get clear errors |
| 13 | Operator the agent doesn't trust | Agent won't deposit |
| 14 | New seller onboards by API | Own wallet, prices, hours and minimum charge; each seller's money and numbers stay separate |
| 15 | Seller's own model endpoint | Billed from reported usage; an outage or blank answer isn't charged |
| 16 | Heavy use | Next call moves to the cheaper tier |

`npm run crash-test` has two parts, both checked on-chain:

- It force-kills the gateway while it holds unclaimed seller money and starts a new one. The seller is still paid in full.
- It makes a refund fail, force-kills the facilitator and starts a new one. Channel cleanup still returns the agent's locked funds.

Scenario 11 and the failed refund can't be caused on demand, so they use test switches in the facilitator. In scenario 11 the payment really lands, but the facilitator reports it as unconfirmed, which matches what public devnet rate limiting caused during development. These switches only exist in demo mode.

## API

| Endpoint | Paid | Purpose |
|---|---|---|
| `POST /s/:seller/generate` | Per call | `{ model, prompt, max_output_tokens }` returns the text and a usage record |
| `POST /s/:seller/batch/generate` | Batch | The same, for repeat callers |
| `GET /s/:seller/channel` | Batch | Where an x402 client closes its channel and gets a refund |
| `POST /s/:seller/quote` | No | The most a request could cost |
| `GET /s/:seller/pricing` | No | Rate card, peak hours, tiers and the operator to trust |
| `GET /v1/receipts/:id` | No | One ledger entry, with its transaction |
| `GET /v1/receipts/:id/answer` | No | Collect an answer withheld during an unconfirmed payment |
| `POST /admin/sellers` | Admin token | Add a seller or update its settings |
| `GET /` and `GET /api/stats` | This machine or admin token | Seller dashboard |

## Code

| File | Purpose |
|---|---|
| `src/pricing.ts` | Rate cards and the pricing engine, in integer atomic units |
| `src/sellers.ts` | Seller registry and validation |
| `src/gateway.ts` | Paid routes, failure handling, reconciliation, redemption |
| `src/ledger.ts` | Append-only usage ledger and seller statistics |
| `src/provider.ts` | Simulated, HTTP and Claude model sources |
| `src/durable.ts` | Channel records and vouchers that survive restarts |
| `src/facilitator.ts` | Self-hosted facilitator, recovery of unknown open channels |
| `src/rpc-shield.ts` | Queue and retry for the rate-limited public devnet RPC |
| `scripts/start-all.ts` | Starts the services in order and stops them all if one dies |
| `scripts/demo.ts`, `scripts/crash-test.ts` | End-to-end checks |

The public x402.org facilitator lists only `exact` on Solana devnet, so this project hosts its own for `upto` and `batch-settlement`.

## Measured on devnet

- **Per-call speed:** about 4 seconds, including both on-chain steps.
- **Batch speed:** median about 190 ms after the first call, with no on-chain payment per call. Opening the channel took from 5 to about 19 seconds, depending on rate limiting.
- **Fees:** 10,001 lamports per transaction (1 SOL = 1 billion lamports). Per-call payment needs 2 transactions per call.
- **Fee comparison:** 10 per-call payments cost about 200,000 lamports in fees. In batch, opening, one claim, one distribution and closing cost about 40,000 lamports. More frequent claims cost more.
- **Rent:** the facilitator fronts refundable account rent, about 1.95 million lamports per per-call channel, which returns through cleanup. In one run its balance rose 17.5 million lamports within minutes, which matches about 9 channels.

At an assumed $150 per SOL, per-call fees are about $0.003 per call, so sellers charging less should set a minimum charge or use batch. Both are built.

## Trust and known limits

- **Batch trust:** in batch mode the operator signs the metered charges, so a dishonest operator could claim up to the whole unused deposit. The agent decides which operators to trust and caps its deposit. For a stranger, use per-call payment, where the chain enforces each ceiling.
- **Devnet only:** this has never run on mainnet, and the payment-channel audit (Cantina, July 2026, per the x402 repository) is something we haven't reviewed ourselves.
- **Test token:** payments use our own devnet token, not USDC.
- **Live Claude not run:** the adapter passes tests through the real SDK against a local stand-in, but has never called the live API. Its margin figures also ignore the higher price of cache writes, and fallback models may cost more than the rate card assumes. Calls time out after 100 seconds to stay inside the payment window, so very long answers fail without charge.
- **One gateway instance:** durable records are JSON snapshots for a single process. Running several instances would need a real database.
- **Agent state:** the demo agent keeps its channel records in memory. A restarted agent would need x402's durable client storage, or a forced close, to recover a deposit.
- **Admin:** one shared token, and no seller self-service. Behind a reverse proxy, every caller would look local to the dashboard check, so change that check before exposing it that way.
- **Lost outcomes:** if the gateway crashes between settling and recording a call, the ledger marks it "Needs review" rather than guessing. The chain remains the source of truth.
- **No platform fee:** sellers receive all of each charge. How the gateway itself earns money isn't built.
- **Withheld answers:** answers kept during an unconfirmed payment are stored unencrypted in `data/ledger.jsonl`.

## License

[MIT](LICENSE)
