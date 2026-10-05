# x402 Paid API Template

Deploy your own paid API in minutes. Every call to a priced endpoint costs USDC on Base — enforced by the [x402 protocol](https://www.x402.org/).

[![Deploy to Fly.io](https://img.shields.io/badge/Deploy_to-Fly.io-8b5cf6?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCIgMjQiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQyIDAgOCAzLjU4IDggOHMzLjU4LTggOC04YzAtNS41Mi00LjQ4LTEwLTEwLTEweiIvPjwvc3ZnPg==)](https://fly.io/apps/new?template=https://github.com/Payloadhq/x402-paid-api-template)

## What you get

- `GET /api/health` — free health check
- `GET /api/free` — free endpoint (show the pattern)
- `GET /api/joke` — **$0.01** per call in USDC
- `GET /api/quote` — **$0.05** per call in USDC
- `GET /.well-known/x402` — machine-readable payment manifest for x402 discovery

Unpaid callers get `402 Payment Required` with everything an x402 client needs to pay.

## Deploy

**Option A — one click:** hit the Deploy button above, then set one secret:

```
PAY_TO=0xYourWalletAddress
```

**Option B — CLI:**

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
| `PAY_TO` | **yes** | — | Your wallet address that receives USDC |
| `X402_NETWORK` | no | `base` | `base` (mainnet) or `base-sepolia` (testnet) |
| `X402_ASSET` | no | `USDC` | Payment asset |
| `X402_DEV_SECRET` | dev only | `change-me-in-production` | Dev-mode verifier secret |
| `X402_FACILITATOR_URL` | prod | — | Facilitator URL; when set, on-chain verification replaces the dev verifier |

The server **refuses to boot** with the dev verifier in production (`NODE_ENV=production` without a facilitator). Set `X402_FACILITATOR_URL` for real money.

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
3. Server verifies on-chain (or via facilitator), serves the response, records it in `data/ledger.jsonl` (replay protection included).

## Learn more

- [x402 Paid API Starter Kit](https://payloadtools.gumroad.com/) — the full kit this template is built from ($79)
- [RevRule](https://payload-rail.fly.dev/revrule-console/) — when money moves, decide who earns what
- Built by [Payload](https://payloadhq.github.io/)

## License

MIT
