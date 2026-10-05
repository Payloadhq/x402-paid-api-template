/**
 * x402-core: minimal payment-requirements + verification core.
 *
 * Implements the x402 protocol pattern faithfully:
 *   1. Server responds 402 with a PAYMENT-REQUIRED header carrying base64-encoded
 *      payment requirements { scheme, network, asset, amount, payTo, resource, nonce, expiresAt }.
 *   2. The payer (human or AI agent) settles on-chain, then retries with an
 *      X-PAYMENT header carrying a base64-encoded payment payload.
 *   3. The server verifies the payload and serves the resource.
 *
 * Two verifiers ship:
 *   - DevVerifier: HMAC-based, for local development and automated tests.
 *   - FacilitatorVerifier: POSTs the payload to a real x402 facilitator
 *     /verify endpoint (e.g. self-hosted x402.rs, thirdweb, or CDP) for production.
 *
 * Non-custodial by design: this module never holds private keys or funds.
 * It only *checks* that a payment happened.
 */
'use strict';

const crypto = require('crypto');

const HEADER_REQUIREMENTS = 'payment-required';
const HEADER_PAYMENT = 'x-payment';

/**
 * Clock-skew tolerance (seconds) applied when enforcing payment-requirement
 * expiry. A requirement is rejected only when it expired more than this long
 * ago, so minor clock disagreement between payer, facilitator, and server
 * does not eat valid payments near the expiry boundary.
 */
const REPLAY_SKEW_TOLERANCE_SEC = 60;

function randomNonce(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Build a payment-requirements object for one priced resource.
 * amount is a decimal string in asset units, e.g. "0.01" (1 cent of USDC).
 */
function buildPaymentRequirements({ payTo, network, asset, amount, resource, expiresInSec = 300 }) {
  if (!payTo || !network || !asset || !amount || !resource) {
    throw new Error('buildPaymentRequirements: payTo, network, asset, amount and resource are required');
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    scheme: 'exact',
    network,
    asset,
    amount: String(amount),
    payTo,
    resource,
    nonce: randomNonce(),
    issuedAt: now,
    expiresAt: now + expiresInSec,
  };
}

function encodeRequirements(req) {
  return Buffer.from(JSON.stringify(req), 'utf8').toString('base64');
}

function decodeRequirements(b64) {
  return JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
}

/** Parse an X-PAYMENT header value into a payment payload object. Returns null on bad input. */
function decodePaymentHeader(value) {
  try {
    if (!value) return null;
    const payload = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Reject a payment whose requirements expired beyond the clock-skew tolerance.
 * Returns { ok: true } when the requirements are still usable.
 * The skew margin is logged on rejection so clock disagreement is visible.
 */
function checkRequirementFreshness(requirements) {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = requirements ? Number(requirements.expiresAt) : NaN;
  if (!Number.isFinite(exp)) {
    return { ok: false, reason: 'payment requirement expired' };
  }
  const marginSec = nowSec - exp;
  if (marginSec > REPLAY_SKEW_TOLERANCE_SEC) {
    console.warn(
      `[x402-core] rejecting payment: requirement expired ${marginSec}s ago ` +
      `(tolerance ${REPLAY_SKEW_TOLERANCE_SEC}s)`
    );
    return { ok: false, reason: 'payment requirement expired' };
  }
  return { ok: true };
}

/**
 * In-memory replay guard. Tracks seen payment nonces and txHashes; nonce
 * entries are pruned once their requirement expiry passes (plus the skew
 * tolerance), so memory stays bounded. Optionally seeded from a ledger so
 * previously recorded txHashes stay blocked across restarts.
 *
 * The guard is deliberately in-memory: it is a live replay filter, not the
 * audit record. The JSONL ledger remains the durable record of paid calls.
 */
function createReplayGuard({ ledger } = {}) {
  const seenNonces = new Map(); // nonce -> expiresAt (unix seconds)
  const seenTx = new Set();     // txHash strings
  if (ledger && typeof ledger.list === 'function') {
    try {
      for (const e of ledger.list()) {
        if (e && e.txHash) seenTx.add(String(e.txHash));
      }
    } catch { /* seeding is best-effort */ }
  }
  function prune(nowSec) {
    for (const [nonce, exp] of seenNonces) {
      if (exp + REPLAY_SKEW_TOLERANCE_SEC < nowSec) seenNonces.delete(nonce);
    }
  }
  return {
    /** True when this nonce/txHash was already verified (prunes first). */
    isReplay({ nonce, txHash } = {}) {
      const nowSec = Math.floor(Date.now() / 1000);
      prune(nowSec);
      const key = nonce || txHash;
      if (key && seenNonces.has(key)) return true;
      if (txHash && seenTx.has(String(txHash))) return true;
      return false;
    },
    /** Record a successfully verified payment. */
    record({ nonce, txHash, expiresAt } = {}) {
      const nowSec = Math.floor(Date.now() / 1000);
      const key = nonce || txHash;
      if (key) seenNonces.set(key, Number.isFinite(+expiresAt) ? +expiresAt : nowSec);
      if (txHash) seenTx.add(String(txHash));
    },
    stats() {
      return { nonces: seenNonces.size, txHashes: seenTx.size };
    },
  };
}

/**
 * Production boot guard. Throws (crashes the process, no warning-only mode)
 * when the dev/HMAC verifier is configured while NODE_ENV=production.
 * paidRoute() calls this automatically; call it directly in custom setups.
 */
function assertProductionVerifier(verifier) {
  if (process.env.NODE_ENV === 'production' && verifier && verifier.name === 'dev') {
    throw new Error(
      'x402: refusing to start with the dev (HMAC) verifier while NODE_ENV=production. ' +
      'Use createFacilitatorVerifier({ verifyUrl }) for production.'
    );
  }
}

function encodePaymentPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * DevVerifier: accepts payments "signed" with a shared dev secret.
 * Dev payload shape: { txHash, from, amount, asset, network, payTo, nonce, sig }
 * where sig = HMAC_SHA256(secret, `${txHash}|${from}|${amount}|${asset}|${network}|${payTo}|${nonce}`).
 * The nonce binds the payment to the 402 challenge it answers, so a captured
 * payload cannot be replayed as a different payment.
 * NEVER use in production — it trusts whoever holds the secret.
 *
 * v1.0.1: verify() rejects expired requirements ('payment requirement expired',
 * 60s clock-skew tolerance) and already-seen nonces/txHashes ('replay detected').
 * Pass a ledger to seed replay protection from previously recorded payments.
 */
function createDevVerifier({ secret, payTo, asset, network, ledger } = {}) {
  if (!secret) throw new Error('createDevVerifier: secret is required');
  const expectedSig = (p) =>
    crypto
      .createHmac('sha256', secret)
      .update([p.txHash, p.from, p.amount, p.asset, p.network, p.payTo, p.nonce || ''].join('|'))
      .digest('hex');
  const guard = createReplayGuard({ ledger });

  return {
    name: 'dev',
    async verify(payload, requirements) {
      if (!payload || !payload.txHash || !payload.from || !payload.sig) {
        return { ok: false, reason: 'malformed payment payload' };
      }
      const fresh = checkRequirementFreshness(requirements);
      if (!fresh.ok) return fresh;
      if (payload.sig !== expectedSig(payload)) {
        return { ok: false, reason: 'invalid payment signature' };
      }
      if (payload.payTo !== requirements.payTo) return { ok: false, reason: 'wrong recipient' };
      if (payload.asset !== requirements.asset || payload.network !== requirements.network) {
        return { ok: false, reason: 'wrong asset or network' };
      }
      if (String(payload.amount) !== String(requirements.amount)) {
        return { ok: false, reason: 'amount mismatch' };
      }
      if (payTo && payload.payTo !== payTo) return { ok: false, reason: 'recipient not configured' };
      if (asset && payload.asset !== asset) return { ok: false, reason: 'asset not configured' };
      if (network && payload.network !== network) return { ok: false, reason: 'network not configured' };
      if (guard.isReplay({ nonce: payload.nonce || null, txHash: payload.txHash })) {
        return { ok: false, reason: 'replay detected' };
      }
      guard.record({ nonce: payload.nonce || null, txHash: payload.txHash, expiresAt: requirements.expiresAt });
      return { ok: true, txHash: payload.txHash, from: payload.from };
    },
    /** Helper for tests and local clients: mint a valid dev payment for given requirements. */
    mintPayment(requirements, { txHash = '0x' + randomNonce(32), from = '0xdevpayer' } = {}) {
      const p = {
        txHash,
        from,
        amount: requirements.amount,
        asset: requirements.asset,
        network: requirements.network,
        payTo: requirements.payTo,
        nonce: requirements.nonce || randomNonce(),
      };
      p.sig = expectedSig(p);
      return p;
    },
    /** Introspection for tests/monitoring: current replay-guard size. */
    replayStats() {
      return guard.stats();
    },
  };
}

/**
 * FacilitatorVerifier: production verifier. POSTs the x402 v1 wire format
 * { paymentPayload, paymentRequirements } to a real x402 facilitator /verify
 * endpoint and trusts its { isValid } answer.
 * Configure verifyUrl to your facilitator, e.g. https://x402.org/facilitator/verify
 * or your self-hosted x402.rs instance. See README "Going to production".
 *
 * Facilitator-aware (v1.0.3): pass supportedAssets / supportedNetworks to
 * declare what YOUR facilitator actually settles (e.g. ['USDC'], ['base']).
 * verify() then fails closed on anything outside that list, and paidRoute()
 * refuses to boot a route whose asset/network the verifier does not support.
 * Without the lists, the verifier accepts any asset/network string (the
 * facilitator remains authoritative at payment time).
 *
 * v1.0.1: expired requirements are rejected locally (never sent to the
 * facilitator), and successfully verified payments are replay-guarded so the
 * same payload cannot unlock the resource twice. The facilitator remains the
 * authoritative check — this is defense in depth, not a replacement.
 *
 * v1.0.4: speaks the canonical x402 v1 /verify wire format —
 * { paymentPayload, paymentRequirements } with paymentRequirements carrying
 * scheme/network/maxAmountRequired/payTo/asset/resource/maxTimeoutSeconds.
 * CAIP-2 network ids are mapped to the v1 names the reference facilitator
 * expects (e.g. eip155:84532 -> base-sepolia; see GET /supported), and the
 * decimal amount is converted to base units via assetDecimals (default 6).
 * Responses accept both { isValid } (canonical v1) and legacy { valid }.
 */
function createFacilitatorVerifier({ verifyUrl, apiKey, timeoutMs = 8000, ledger, supportedAssets, supportedNetworks, assetDecimals = 6 } = {}) {
  if (!verifyUrl) throw new Error('createFacilitatorVerifier: verifyUrl is required');
  const guard = createReplayGuard({ ledger });
  const assetSet = Array.isArray(supportedAssets) ? new Set(supportedAssets.map(String)) : null;
  const networkSet = Array.isArray(supportedNetworks) ? new Set(supportedNetworks.map(String)) : null;
  const decimals = Number(assetDecimals) || 6;
  // x402 v1 network names expected by the reference facilitator (from its
  // GET /supported). Unknown ids pass through unchanged.
  const V1_NETWORK_NAMES = {
    'eip155:84532': 'base-sepolia',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
  };
  const toV1Network = (n) => V1_NETWORK_NAMES[String(n)] || String(n);
  // Decimal string ("0.10") -> base-unit integer string ("100000").
  const toBaseUnits = (amount) => {
    const [i, f = ''] = String(amount).split('.');
    const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
    return ((BigInt(i || '0') * 10n ** BigInt(decimals)) + BigInt(frac || '0')).toString();
  };
  const payloadKey = (payload) =>
    (payload && (payload.txHash || payload.nonce)) ||
    'hash:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  function supports({ asset, network } = {}) {
    if (assetSet && asset !== undefined && !assetSet.has(String(asset))) {
      return { ok: false, reason: `asset ${asset} not in this facilitator's supported assets [${[...assetSet].join(', ')}]` };
    }
    if (networkSet && network !== undefined && !networkSet.has(String(network))) {
      return { ok: false, reason: `network ${network} not in this facilitator's supported networks [${[...networkSet].join(', ')}]` };
    }
    return { ok: true };
  }
  return {
    name: 'facilitator',
    supportedAssets: assetSet ? [...assetSet] : undefined,
    supportedNetworks: networkSet ? [...networkSet] : undefined,
    supports,
    async verify(payload, requirements) {
      const compat = supports(requirements || {});
      if (!compat.ok) return compat;
      const fresh = checkRequirementFreshness(requirements);
      if (!fresh.ok) return fresh;
      const key = payloadKey(payload);
      if (guard.isReplay({ nonce: key, txHash: payload && payload.txHash })) {
        return { ok: false, reason: 'replay detected' };
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      // Canonical x402 v1 /verify envelope.
      const maxTimeoutSeconds = Math.max(1, Math.round(
        ((requirements.expiresAt || 0) - (requirements.issuedAt || Math.floor(Date.now() / 1000))) || 300));
      const paymentRequirements = {
        scheme: requirements.scheme || 'exact',
        network: toV1Network(requirements.network),
        maxAmountRequired: toBaseUnits(requirements.amount),
        payTo: requirements.payTo,
        asset: requirements.asset,
        resource: requirements.resource,
        maxTimeoutSeconds,
      };
      try {
        const res = await fetch(verifyUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements }),
          signal: ctrl.signal,
        });
        if (!res.ok) return { ok: false, reason: `facilitator HTTP ${res.status}` };
        const data = await res.json();
        const valid = data && (data.isValid === true || data.valid === true);
        if (valid) {
          guard.record({ nonce: key, txHash: payload && payload.txHash, expiresAt: requirements.expiresAt });
          const from = (data && data.payer) || (payload && (payload.from || (payload.payload && payload.payload.authorization && payload.payload.authorization.from)));
          return { ok: true, txHash: payload.txHash, from };
        }
        const reason = (data && (data.invalidReason || data.invalidMessage || data.reason)) || 'facilitator rejected payment';
        return { ok: false, reason };
      } catch (err) {
        return { ok: false, reason: `facilitator unreachable: ${err.message}` };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** Append-only JSON-lines ledger of paid calls. */
function createLedger({ file } = {}) {
  const fs = require('fs');
  const path = require('path');
  const entries = [];
  if (file) {
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (line.trim()) entries.push(JSON.parse(line));
        }
      }
    } catch { /* start empty on corrupt file */ }
  }
  return {
    record(entry) {
      const row = { at: new Date().toISOString(), ...entry };
      entries.push(row);
      if (file) fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    },
    list() {
      return entries.slice();
    },
    total() {
      return entries.length;
    },
  };
}

module.exports = {
  HEADER_REQUIREMENTS,
  HEADER_PAYMENT,
  REPLAY_SKEW_TOLERANCE_SEC,
  buildPaymentRequirements,
  encodeRequirements,
  decodeRequirements,
  decodePaymentHeader,
  encodePaymentPayload,
  createDevVerifier,
  createFacilitatorVerifier,
  createLedger,
  checkRequirementFreshness,
  createReplayGuard,
  assertProductionVerifier,
};
