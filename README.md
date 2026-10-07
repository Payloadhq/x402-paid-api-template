# x402 Paid API Template

**Deploy your own paid API in minutes. By Payload.**

This is the free, open-source template (MIT): a working Express server with
paid x402 routes you can deploy and adapt.

Every call to a priced endpoint costs USDC on Base, enforced by the
[x402 protocol](https://www.x402.org/) — once the production facilitator is
configured. Out of the box the template boots with a local HMAC dev verifier
for testing, which accepts locally signed test payments only.

[![Deploy to Fly.io](https://img.shields.io/badge/Deploy_to-Fly.io-8b5cf6)](https://fly.io/apps/new?template=https://github.com/Payloadhq/x402-paid-api-template)

## What you get

- `GET /api/health`: free health check
- `GET /api/free`: free endpoint (show the pattern)
- `GET /api/joke`: **$0.01** per call in USDC
- `GET /api/quote`: **$0.05** per call in USDC
- `GET /.well-known/x402`: machine-readable payment manifest for x402 discovery

Unpaid callers get `402 Payment Required` with everything an x402 client needs to pay.

## Deploy

**Option A: one click** hit the Deploy button above, then set one secret:

```
PAY_TO=0xYourWalletAddress
```

**Option B: CLI**

```bash
git clone https://github.com/Payloadhq/x402-paid-api-template.git
cd x402-paid-api-template
npm install
fly launch  # accepts the generated fly.toml
fly secrets set PAY_TO=0xYourWalletAddress
```

## Configure

| Env var | Required | Default | What it does |
|---|---|---|---|
| `PAY_TO` | recommended | `0xYourReceivingWalletAddress` (placeholder) | Your wallet address that receives USDC. The server boots without it, but set it to receive real payments |
| `X402_NETWORK` | no | `base` | `base` (mainnet) or `base-sepolia` (testnet) |
| `X402_ASSET` | no | `USDC` | Payment asset |
| `X402_DEV_SECRET` | dev only | `change-me-in-production` | Dev-mode verifier secret |
| `X402_FACILITATOR_URL` | prod | none | Facilitator URL; when set, on-chain verification replaces the dev verifier |

The server **refuses to boot** with the dev verifier in production
(`NODE_ENV=production` without a facilitator). Set `X402_FACILITATOR_URL`
for real money.

## Add your own priced endpoint

```js
app.get('/api/premium', priced('0.10', 'GET /api/premium'), (req, res) => {
  res.json({ data: 'worth every microcent' });
});
```

That's it. Wrap any Express route with `priced('amount', 'description')`.

## Local dev

```bash
npm install
PAY_TO=0xYourWalletAddress npm start
curl localhost:3402/api/joke -i   # 402 with payment instructions
```

## How payments work

1. Client calls a priced endpoint → gets `402` + `PAYMENT-REQUIRED` details.
2. Client pays USDC to `PAY_TO` on Base and retries with `PAYMENT-SIGNATURE`.
3. Server verifies the payment (dev verifier for local testing; facilitator
   verifier for production), serves the response, records it in
   `data/ledger.jsonl` (replay protection included).

## Keep it healthy, scale it up

- **Validate your manifest in CI:** [x402-manifest-check](https://github.com/Payloadhq/x402-manifest-check)
  by Payload: free CLI + GitHub Action.
- **When a 402 breaks in production:** callx402 by Payload — powered by Veyline
  diagnoses and rescues broken x402 calls. When x402 breaks, callx402.
- **Going to production at scale:** Veyline by Payload is the production layer
  for x402 + MCP: autonomous economic control for machine commerce.
- **Learn the full pattern:** the
  [Veyline Developer Primer](https://payloadtools.gumroad.com/l/x402-paid-api-starter-kit)
  (formerly the x402 Paid API Starter Kit, $79) — the complete commercial
  package this template's pattern is drawn from.

Built by [Payload](https://payloadhq.github.io/).

## License

MIT

---

**More from Payload** · [payloadhq.github.io](https://payloadhq.github.io/) · [all Payload repos](https://github.com/Payloadhq)

Related: [x402-paid-api-starter-kit](https://github.com/Payloadhq/x402-paid-api-starter-kit) · [flow-agentic-demo](https://github.com/Payloadhq/flow-agentic-demo)
