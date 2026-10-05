/**
 * Paid API server — deploy this and charge per API call in USDC on Base.
 *
 * 1. Set PAY_TO to your wallet address (env var).
 * 2. Deploy (Fly.io button in README, or `fly launch`).
 * 3. Your API now returns 402 with payment instructions until the caller pays.
 *
 * Built on the x402 Paid API Starter Kit by Payload.
 */
'use strict';

const path = require('path');
const express = require('express');
const { createDevVerifier, createFacilitatorVerifier, createLedger, assertProductionVerifier } = require('./x402-core');
const { paidRoute, manifestRoute } = require('./express-middleware');

const PORT = parseInt(process.env.PORT || '3402', 10);

// ---- configure your business here ---------------------------------------
const CONFIG = {
  payTo: process.env.PAY_TO || '0xYourReceivingWalletAddress',
  network: process.env.X402_NETWORK || 'base',
  asset: process.env.X402_ASSET || 'USDC',
  // In production, use a facilitator instead of the dev verifier:
  // facilitatorUrl: process.env.X402_FACILITATOR_URL,
};
// --------------------------------------------------------------------------

const ledger = createLedger({ file: path.join(__dirname, 'data', 'ledger.jsonl') });

let verifier;
if (process.env.X402_FACILITATOR_URL) {
  verifier = createFacilitatorVerifier({
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    payTo: CONFIG.payTo,
    asset: CONFIG.asset,
    network: CONFIG.network,
    ledger,
  });
} else {
  verifier = createDevVerifier({
    secret: process.env.X402_DEV_SECRET || 'change-me-in-production',
    payTo: CONFIG.payTo,
    asset: CONFIG.asset,
    network: CONFIG.network,
    ledger,
  });
}
assertProductionVerifier(verifier);

const app = express();

const priced = (price, resource) =>
  paidRoute({
    price,
    payTo: CONFIG.payTo,
    network: CONFIG.network,
    asset: CONFIG.asset,
    verifier,
    ledger,
    resource,
  });

app.get('/api/health', (req, res) => res.json({ ok: true, payTo: CONFIG.payTo }));

// Free route — no payment required
app.get('/api/free', (req, res) => {
  res.json({ message: 'This endpoint is free. The ones below cost USDC per call.' });
});

// Priced routes — 402 until paid
app.get('/api/joke', priced('0.01', 'GET /api/joke'), (req, res) => {
  res.json({ joke: 'Why do programmers prefer dark mode? Because light attracts bugs.' });
});

app.get('/api/quote', priced('0.05', 'GET /api/quote'), (req, res) => {
  res.json({ quote: 'The best way to predict the future is to invent it.', author: 'Alan Kay' });
});

// Machine-readable payment manifest (x402 discovery)
app.get('/.well-known/x402', manifestRoute({
  baseUrl: process.env.PUBLIC_BASE_URL || '',
  endpoints: [
    { method: 'GET', path: '/api/joke', price: '0.01', asset: CONFIG.asset, network: CONFIG.network, description: 'A programmer joke, $0.01 per call' },
    { method: 'GET', path: '/api/quote', price: '0.05', asset: CONFIG.asset, network: CONFIG.network, description: 'An inspirational quote, $0.05 per call' },
  ],
}));

app.listen(PORT, () => {
  console.log(`Paid API listening on :${PORT} — payTo ${CONFIG.payTo}`);
});
