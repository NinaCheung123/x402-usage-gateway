# The idea / 这个项目是什么

## In one sentence / 一句话

**English:** An AI agent with no account can pay for an AI API, with a hard cap on what it can spend, and is charged for the usage the seller's model reports. Any seller can join with a wallet, a price list and a model, and doesn't have to build usage billing.

**中文：** AI agent 不用注册账号，就能付费调用 AI API。支出有硬性上限，并按卖方模型报告的用量收费。任何卖方只需提供钱包、价目表和模型即可接入，不必自己开发用量计费系统。

**What's new here / 这个项目新增了什么:** x402 already provides locking a maximum, settling less and batching. This project adds pricing, seller onboarding, a ledger, failure handling and recovery. x402 已经提供锁定上限、按更低金额结算和批量结算；本项目在此之上增加了定价、卖方接入、账本、失败处理和恢复功能。

## The problem / 要解决的问题

**English:** An AI company's price depends on the model, the token type (input, cached input, output), the customer's tier and the time of day. The final cost isn't known until the answer is finished. Today's normal route needs a signup, a saved card and a monthly bill, which doesn't suit a software agent that finds a new API and wants to use it once. Fixed-price pay-per-call doesn't fit either, because nobody knows the cost in advance.

**中文：** AI 公司的价格取决于模型、token 类型（输入、缓存输入、输出）、客户等级和时段，回答生成完才知道最终费用。现在的常规路径要注册账号、绑定信用卡、按月结账，不适合临时发现一个 API、只想调用一次的 agent。固定价格按次收费也不合适，因为费用无法事先确定。

## How it works, like a hotel deposit / 工作方式：就像酒店押金

**English:**
1. **Ask.** The agent calls the API with no account and gets `402 Payment Required`, with the maximum this request could cost.
2. **Lock.** The agent locks up to that maximum on Solana in a payment channel, a small on-chain escrow. The seller can't take more than this.
3. **Work.** The gateway runs the AI model and counts the tokens delivered.
4. **Price.** The pricing engine applies the model, token type, tier and time of day.
5. **Settle.** The seller receives the actual charge, and the rest goes back to the agent in the same settlement.
6. **Record.** The agent gets a usage record. The seller sees revenue, model cost and margin.

**中文：**
1. **询价：** agent 不用账号直接调用 API，收到 `402 Payment Required`，其中写明这次请求的最高费用。
2. **锁定：** agent 在 Solana 的支付通道（一个链上小型托管）里锁定这笔上限。卖方最多只能收这么多。
3. **执行：** 网关运行 AI 模型，统计实际交付的 token。
4. **计价：** 定价引擎按模型、token 类型、客户等级和时段计算费用。
5. **结算：** 卖方收到实际费用，其余部分在同一次结算中退回 agent。
6. **记录：** agent 拿到用量记录，卖方能看到收入、模型成本和毛利。

## Two ways to pay / 两种付款方式

**English:**
- **Per call, for strangers:** the hotel deposit above. Solana enforces the limit on every call, so the agent doesn't have to trust the seller. Each call takes about 4 seconds and pays network fees.
- **Batch, for regulars:** like a bar tab. The agent deposits once, then calls freely, with a median of a few hundred milliseconds and no on-chain payment per call. The seller claims the running total in batches, and the agent gets the unused deposit back. The agent has to trust the operator for what it deposits, so it chooses whom to trust and caps the amount.

**中文：**
- **按次付款，适合陌生调用方：** 就是上面的酒店押金。Solana 在每次调用时强制执行上限，agent 不必信任卖方。每次调用约 4 秒，并要支付网络费。
- **批量付款，适合常客：** 就像酒吧记账。agent 只存一次押金，之后可以直接调用，中位耗时约几百毫秒，每次调用都不需要链上付款。卖方分批领取累计金额，未用完的押金退回 agent。agent 需要在押金范围内信任运营方，所以由它决定信任谁，并设置金额上限。

## How a seller joins / 卖方如何接入

**English:** The seller registers a wallet, a price list and a model source. The source can be its own model endpoint or Claude. The price list sets the model, token type, customer tier, peak hours and minimum charge. The seller then gets paid endpoints, a ledger and a dashboard showing revenue, model cost and margin.

**中文：** 卖方注册钱包、价目表和模型来源。模型来源可以是自己的模型接口，也可以是 Claude。价目表可设定模型、token 类型、客户等级、高峰时段和最低收费。接入后，卖方就有了收费接口、账本和显示收入、模型成本与毛利的后台。

## Why Solana / 为什么用 Solana

**English:** Payments lock and settle real tokens through a Solana programme, which only makes sense when fees are tiny and confirmation is quick. The programme enforces the ceiling on-chain, and batching makes very small calls affordable. The agent also doesn't need SOL, because the facilitator (the service that submits the transactions) sponsors the fees.

**中文：** 付款要通过 Solana 程序锁定并结算真实代币，只有手续费极低、确认够快才合理。程序在链上强制执行上限，批量结算则让极小额调用也划算。agent 也不需要持有 SOL，因为 facilitator（负责提交交易的服务）会代付手续费。

## When things go wrong / 出问题时怎么办

| Situation / 情况 | What happens / 结果 |
|---|---|
| No payment / 没有付款 | `402`, no access. 返回 `402`，不能访问。 |
| Payment fails (no funds) / 付款失败（余额不足） | Clear error, no AI work starts. 返回明确错误，不启动 AI 任务。 |
| AI provider fails after funds are locked / 资金锁定后 AI 服务失败 | Agent isn't charged. agent 不被收费。 |
| Answer cut off / 回答被截断 | Charged for delivered tokens only. 只收已交付 token 的费用。 |
| Reused payment proof / 重复使用付款凭证 | Rejected, and the model never runs. 被拒绝，模型也不会运行。 |
| Agent's money can't cover the maximum / agent 的资金不够支付上限 | The call doesn't start. The agent shortens the request or picks a cheaper model. 调用不会开始，agent 可以缩短请求或换便宜模型。 |
| Provider returns more than allowed / 模型输出超过上限 | Charge stops at the ceiling. The seller absorbs the extra and the ledger shows it. 收费停在上限，超出部分由卖方承担并记入账本。 |
| Payment lands but can't be confirmed / 付款到账但无法确认 | Agent collects the answer later and is charged once. agent 之后可领取答案，只收费一次。 |
| Gateway crashes while owed money / 网关崩溃时尚有未领取款项 | Seller is still paid in full after restart, and used proofs stay refused. 重启后卖方仍能全额收款，已用过的凭证仍会被拒绝。 |
| Seller's model endpoint is down / 卖方模型接口故障 | Agent isn't charged. agent 不被收费。 |
| Model returns a blank answer / 模型返回空白答案 | Agent isn't charged. The seller's cost is recorded. agent 不被收费，卖方成本记入账本。 |
| Agent hangs up mid-call / agent 中途断开 | The charge is recorded, and the agent recovers the answer for free. 收费被正确记录，agent 可以免费取回答案。 |
| Refund fails / 退款失败 | The ledger says pending, and channel cleanup returns the funds. 账本显示待处理，通道清理会退回资金。 |

**Balance running out mid-call / 调用中途余额耗尽:** this can't happen by design, because the call's maximum is reserved before work starts. 按设计不会发生，因为这次调用的上限在开始前就已预留。

## What's real and what isn't / 哪些是真实的，哪些不是

**Tested with real devnet payments / 已用真实 devnet 支付测试:**
- Both payment methods, all failure cases above, and multiple sellers. 两种付款方式、上表所有失败情况，以及多个卖方。

**Not real yet / 尚非真实:**
- The token is our own devnet test token, not USDC, and nothing has run on mainnet. 代币是自建的 devnet 测试币，不是 USDC，也没有在主网运行过。
- The demo's AI answers and token counts are simulated. 演示中的 AI 回答和 token 数是模拟的。
- Model names and prices in the demo are examples. 演示中的模型名和价格都是示例。
- The Claude connection has only been tested against a local stand-in, never the live API. Claude 接入只用本地替身测试过，没有调用过真实 API。
- Records are built for one gateway server, and how the gateway itself earns money isn't built. 记录系统只适用于单台网关服务器，网关自身的收费方式也还没做。

**Measured cost / 实测成本:** per-call payment pays about 20,000 lamports in network fees per call, or about $0.003 if SOL is $150 (an assumed price). Batching lowers this. The dashboard estimates these fees. 按次付款每次约需 20,000 lamports 网络费；假设 SOL 为 150 美元，约合 0.003 美元。批量付款可以降低这笔费用。后台会估算这些费用。

**Business model / 商业模式:** sellers run the gateway themselves and pay their own network fees, so no middleman holds the money. A hosted version for many sellers would need a subscription or monthly invoice, which isn't built. 卖方自己运行网关并承担网络费，因此没有中间方经手资金。如果要做面向多个卖方的托管版本，需要订阅费或按月开票，这一点还没做。

**What the chain can't prove / 链上无法证明的事:** Solana enforces the spending cap, but it can't see whether a seller counted tokens honestly. Solana 会强制执行支出上限，但无法判断卖方是否如实统计 token。

## How this relates to the PayPal project / 与 PayPal 项目的关系

**English:** The two hackathons share the pricing engine and ledger idea, but they're different products. This one is for agents paying with no account, through x402 on Solana. The PayPal one is a billing service for AI and software companies whose customers use accounts, saved payment methods and subscriptions.

**中文：** 两个黑客松共用定价引擎和账本的思路，但产品不同。这个项目面向无账号付费的 agent，通过 Solana 上的 x402 收款。PayPal 项目则是给 AI 和软件公司的计费服务，其客户使用账号、已保存的付款方式和订阅。
