# x402 Usage Gateway

Usage-based billing for AI APIs, with no accounts. An AI agent pays through x402 on Solana, with a hard cap on what it can spend, and is charged for what the seller's model reports it used. A seller registers a wallet, a rate card and a model source, and gets pricing, settlement, refunds, a ledger and a margin view without building billing.

**What's x402 and what's this project:** locking a maximum, settling a lower amount and batching are x402 capabilities (`upto` and `batch-settlement`). This project adds what a seller still needs around them: rate cards and pricing, seller onboarding, a usage ledger, failure handling, crash recovery and answer recovery.

**Best suited to** specialist API sellers who want external agents as customers without building billing. It's a devnet prototype with no customers yet.

Plain explanation in English and Chinese / 中英文说明: [docs/IDEA.md](docs/IDEA.md)

## How an agent pays

There are two ways to pay. Both use the same pricing, ledger and failure handling.

| | Per call (`upto`) | Batch (`batch-settlement`) |
|---|---|---|
| **Suits** | A one-off caller that doesn't trust the seller | A repeat caller |
| **Funds** | Locks each call's maximum | One deposit covers many calls |
| **On-chain** | 2 transactions per call | Open once, claim in batches, close once |
| **Measured speed** | About 4 seconds per call | Median about 190 to 360 ms after the first call |
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

The quickest way is the guided setup, which asks a few questions, creates the wallet's token account if needed, and checks that the seller is ready to take payment. The gateway must be running.

```bash
npm run add-seller
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

To reset the numbers, first check that the dashboard shows nothing metered and unclaimed, because these files track money sellers haven't collected yet. Then stop the services and delete `ledger.jsonl`, `gateway-channels.json`, `batch-transactions.json` and `gateway-operations.jsonl` from `data/` together. Deleting only the ledger makes batch fees per call look too high, because channels from earlier runs still count. Keep the other files in `data/`.

## What's tested

`npm run demo` makes real devnet payments and checks money movements against on-chain balances, not the gateway's own numbers. It exits with an error if any check fails.

| # | Scenario | Expected result |
|---|---|---|
| 1 | Invalid request or unknown seller | `400` or `404` before anyone locks money |
| 2 | No payment, or a rewritten path | `402` with the ceiling; no money moves and no free answer |
| 3 | Normal call | Agent pays and seller receives exactly the charge |
| 3b | Agent hangs up mid-call | The charge lands, the ledger records it, and the agent recovers the answer for free |
| 4 | Repeated prompt | Cached input makes it cheaper |
| 5 | AI provider fails after the lock | `502`; agent loses nothing |
| 6 | Answer cut off | Charged only for delivered tokens |
| 7 | Provider exceeds the limit | Charge stops at the ceiling; seller's loss recorded |
| 8 | Reused payment proof | Rejected; the AI model never runs |
| 9 | Wallet has no funds | Clear error; no work starts |
| 10 | Quote exceeds the agent's limit | x402 client refuses; agent switches to a cheaper model |
| 11 | Payment lands but can't be confirmed | Agent collects the answer later; charged once |
| 12 | Repeat caller | One deposit; seller's claim equals the sum of charges; agent's net cost equals the charges after refund; the same request sent twice at once runs once; replayed proofs and empty wallets get clear errors |
| 13 | Operator the agent doesn't trust | Agent won't deposit |
| 14 | New seller onboards by API or guided setup | Own wallet, prices, hours and minimum charge; paid straight away; each seller's money and numbers stay separate |
| 15 | Seller's own model endpoint | Billed from reported usage; an outage or blank answer isn't charged |
| 16 | Heavy use | Next call moves to the cheaper tier |

The demo checks exact balances, so run one test at a time. Other tests using the same wallets, or an old lock being returned at startup, can make a check fail with no money lost. If that happens, run it again.

`npm run crash-test` has three parts, all checked on-chain:

- It force-kills the gateway while it holds unclaimed seller money and starts a new one. The seller is still paid in full, a used payment proof is still refused and not charged again, and its answer can still be recovered.
- It force-kills the gateway at three moments inside a batch call, as described in [Crashes during a call](#crashes-during-a-call). The agent's net cost and the seller's receipts must match exactly what was charged.
- It makes a refund fail, force-kills the facilitator and starts a new one. Channel cleanup still returns the agent's locked funds.

Scenario 11 and the failed refund can't be caused on demand, so they use test switches in the facilitator. In scenario 11 the payment really lands, but the facilitator reports it as unconfirmed, which matches what public devnet rate limiting caused during development. These switches only exist in demo mode.

## Crashes during a call

On restart, the gateway compares its ledger with its payment records and settles every call the crash cut off. It's still impossible to charge a used proof twice.

| Gateway dies | Batch call becomes | Agent | Seller |
|---|---|---|---|
| Before an answer is saved | Interrupted, no charge | Told it wasn't charged and to send a new request | Told its model may still have billed it |
| After the answer, before the charge | Interrupted, answer held | Told the price, and may pay it at `resume_url` to collect the answer without the model running again, or do nothing | Shown the uncollected amount; paid if the agent collects |
| After the charge, before the ledger | Metered, from the payment records | Collects the answer free at `/v1/recover` | Paid as normal |

The agent hears this from `POST /v1/recover`, its receipt, or a retry of the same proof. The seller sees it under "Interrupted calls" on the dashboard and in `attention` from `/api/stats`.

Paying is the agent's choice, because it never received the answer. Held answers expire with other stored answers, and the seller then carries the model cost.

A per-call payment settles through the facilitator, so the gateway can't tell from its own records whether money moved. It's marked "Needs review", is never billed again, and both sides are told to check the chain.

## API

| Endpoint | Paid | Purpose |
|---|---|---|
| `POST /s/:seller/generate` | Per call | `{ model, prompt, max_output_tokens }` returns the text and a usage record |
| `POST /s/:seller/batch/generate` | Batch | The same, for repeat callers |
| `GET /s/:seller/channel` | Batch | Where an x402 client closes its channel and gets a refund |
| `POST /s/:seller/quote` | No | The most a request could cost |
| `GET /s/:seller/pricing` | No | Rate card, peak hours, tiers and the operator to trust |
| `GET /v1/receipts/:id` | No | One ledger entry, with its transaction |
| `GET /v1/receipts/:id/answer` | No | Collect a paid answer by receipt |
| `POST /v1/recover` | No | Lost the response and have no receipt? Send your payment proof to collect the answer |
| `POST /s/:seller/batch/resume/:id` | Batch | Pay the original price to collect an answer held after a crash. The model doesn't run again |
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
- **Batch speed:** median about 190 to 360 ms across runs, after the first call, with no on-chain payment per call. Opening the channel took from 5 to about 19 seconds, depending on rate limiting.
- **Fees:** 10,001 lamports per transaction (1 SOL = 1 billion lamports). Per-call payment needs 2 transactions per call.
- **Fee comparison:** 10 per-call payments cost about 200,000 lamports in fees. In batch, opening, one claim, one distribution and closing cost about 40,000 lamports. More frequent claims cost more.
- **Rent:** the facilitator fronts refundable account rent, about 1.95 million lamports per per-call channel, which returns through cleanup. In one run its balance rose 17.5 million lamports within minutes, which matches about 9 channels.

## What it guarantees, and who pays

**Guaranteed by the chain:** an agent can't lose more than it locked per call, or more than its deposit in a batch. A proof can't be spent twice, and this check survives restarts.

**Not guaranteed:** Solana can't see whether a seller counted tokens honestly or delivered something useful. Usage is whatever the model source reports. This is a hard payment cap with reported metering, not proof of consumption.

**Business model:** sellers run the gateway themselves and pay their own network fees. The money sits in the Solana programme's escrow and then goes to the seller, so no middleman holds it. A seller's minimum charge can then cover its fees.

**If one operator hosted many sellers:** the demo registers several sellers on one gateway to show that their money stays separate, but that operator would pay all the fees and earn nothing. A hosted version would need a subscription or monthly invoice, which isn't built. In this x402 version each channel pays one recipient, so a percentage can't simply be split off on-chain.

**Which payment to use:** per-call payment costs about $0.003 per call in fees, assuming $150 per SOL. Use it for charges well above that, and use batch for smaller ones. Fees per call fall as a channel carries more calls.

**What the dashboard shows:** an estimate of network fees, by payment method, with a margin after both model and network cost. Set the assumptions with `ASSUMED_SOL_PRICE` (in payment tokens) and `ASSUMED_LAMPORTS_PER_TX`. It excludes refundable account rent and infrastructure. The demo's charges are tiny, so this margin is usually negative there, which is what the rule above predicts.

## Trust and known limits

- **Batch trust:** in batch mode the operator signs the metered charges, so a dishonest operator could claim up to the whole unused deposit. The agent decides which operators to trust and caps its deposit. For a stranger, use per-call payment, where the chain enforces each ceiling.
- **Devnet only:** this has never run on mainnet, and the payment-channel audit (Cantina, July 2026, per the x402 repository) is something we haven't reviewed ourselves.
- **Test token:** payments use our own devnet token, not USDC.
- **Live Claude not run:** the adapter passes tests through the real SDK against a local stand-in, but has never called the live API. Its margin figures also ignore the higher price of cache writes, and fallback models may cost more than the rate card assumes. Calls time out after 100 seconds to stay inside the payment window, so very long answers fail without charge.
- **One gateway instance:** durable records are JSON snapshots for a single process. Running several instances would need a real database.
- **Agent state:** the demo agent keeps its channel records in memory. A restarted agent would need x402's durable client storage, or a forced close, to recover a deposit.
- **Admin:** one shared token, with guided setup run by whoever holds it, and no seller self-service. Behind a reverse proxy, every caller would look local to the dashboard check, so change that check before exposing it that way.
- **Lost outcomes:** if the gateway crashes between settling and recording a per-call payment, the ledger marks it "Needs review" rather than guessing, and tells both sides how to check. The chain remains the source of truth.
- **No platform fee:** sellers receive all of each charge. How the gateway itself earns money isn't built.
- **Stored answers:** paid answers are kept for 24 hours for recovery, unencrypted in `data/ledger.jsonl`. Set `ANSWER_RETENTION_HOURS` to change this.
- **No real service yet:** the demo's answers are simulated, so this shows the payment flow working, not a product customers want.
- **Claude billing:** the adapter charges for all output tokens the API reports, which includes thinking as well as visible text. A seller should tell its customers so.
- **Ceiling estimate:** the maximum uses a rough character-based token estimate, not a tokenizer. If real usage exceeds it, the agent still pays no more than the lock and the seller absorbs the rest.
- **Lost responses in the x402 client:** when a batch request dies with no response, that client object refuses further payments on the channel, and x402 has no way to clear it. An agent should start a new client object, as `npm run crash-test` does.
- **Crash mid-call:** see [Crashes during a call](#crashes-during-a-call). A seller can still lose a charge if the agent never collects a held answer, or if no answer was saved, and the agent can only learn about it by asking: the gateway has no way to contact an agent first.

## Next steps

- **Ask for more instead of absorbing an overrun:** stream the model's output, pause when a call reaches its lock, and let the agent approve more or stop with what it has. Until this is built, the seller absorbs anything above the lock. Not built yet.

## License

[MIT](LICENSE)
