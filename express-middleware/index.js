/**
 * express-middleware: drop-in x402 paid-route middleware for Express 4/5.
 *
 *   const { paidRoute, manifestRoute } = require('./express-middleware');
 *
 *   app.get('/api/joke',
 *     paidRoute({ price: '0.01', payTo: '0xYourWallet', network: 'base', asset: 'USDC', verifier }),
 *     (req, res) => res.json({ joke: '...' }));
 *
 *   app.get('/.well-known/x402', manifestRoute({ baseUrl, endpoints }));
 */
'use strict';

const {
  HEADER_REQUIREMENTS,
  HEADER_PAYMENT,
  buildPaymentRequirements,
  encodeRequirements,
  decodePaymentHeader,
  assertProductionVerifier,
} = require('../x402-core');

/**
 * options:
 *   price    - decimal string in asset units, e.g. '0.01'
 *   payTo    - your receiving wallet address (checksummed)
 *   network  - e.g. 'base', 'ethereum', 'solana', 'polygon'
 *   asset    - e.g. 'USDC'
 *   verifier - from x402-core (dev or facilitator). Required.
 *   ledger   - optional createLedger() instance; paid calls are recorded.
 *   resource - optional label; defaults to the request path.
 */
function paidRoute({ price, payTo, network, asset, verifier, ledger, resource } = {}) {
  if (!price || !payTo || !network || !asset) {
    throw new Error('paidRoute: price, payTo, network and asset are required');
  }
  if (!verifier || typeof verifier.verify !== 'function') {
    throw new Error('paidRoute: a verifier from x402-core is required');
  }
  // Crash at startup (not a warning) if the dev verifier is wired in production.
  assertProductionVerifier(verifier);
  // Fail fast at startup if the verifier declares facilitator capabilities
  // that do not cover this route's asset/network. A misconfigured route
  // should crash the boot, not 402 at payment time.
  if (verifier && typeof verifier.supports === 'function') {
    const compat = verifier.supports({ asset, network });
    if (!compat.ok) {
      throw new Error(`paidRoute(${resource || price + ' ' + asset + ' on ' + network}): ` + compat.reason);
    }
  }

  return async function x402PaidRoute(req, res, next) {
    const label = resource || `${req.method} ${req.path}`;
    const requirements = buildPaymentRequirements({
      payTo, network, asset, amount: price, resource: label,
    });

    const challenge = (reason) => {
      res.status(402);
      res.set(HEADER_REQUIREMENTS, encodeRequirements(requirements));
      res.set('content-type', 'application/json');
      res.json({
        error: 'payment_required',
        reason: reason || 'This endpoint costs ' + price + ' ' + asset + ' on ' + network + '.',
        paymentRequirements: requirements,
        howToPay: 'Settle ' + price + ' ' + asset + ' to ' + payTo + ' on ' + network +
          ', then retry with an X-PAYMENT header carrying the base64 payment payload.',
      });
    };

    const raw = req.get(HEADER_PAYMENT);
    if (!raw) return challenge();

    const payload = decodePaymentHeader(raw);
    if (!payload) return challenge('unreadable X-PAYMENT header');

    let result;
    try {
      result = await verifier.verify(payload, requirements);
    } catch (err) {
      return challenge('verification error: ' + err.message);
    }
    if (!result.ok) return challenge(result.reason || 'payment rejected');

    if (ledger) {
      ledger.record({
        resource: label,
        amount: requirements.amount,
        asset: requirements.asset,
        network: requirements.network,
        txHash: result.txHash || payload.txHash,
        from: result.from || payload.from,
      });
    }
    req.x402 = { payment: result, requirements };
    return next();
  };
}

/**
 * Serves GET /.well-known/x402 — the machine-readable price list agents use
 * for discovery (also consumed by x402 bazaar listings).
 *
 * options:
 *   baseUrl     - public base URL of the API.
 *   endpoints   - [{ method, path, price, asset, network, description }].
 *   asset       - default asset for the manifest and for endpoints that do not
 *                 set their own (default 'USDC'). Each endpoint may override
 *                 with its own asset for multi-asset APIs.
 *   name, description - manifest metadata.
 */
function manifestRoute({ baseUrl, endpoints = [], name, description, asset } = {}) {
  const defaultAsset = asset || 'USDC';
  const manifest = {
    name: name || 'x402 paid API',
    description: description || 'Pay-per-call API. See endpoints for prices.',
    baseUrl: baseUrl || '',
    payment: { scheme: 'exact', asset: defaultAsset },
    endpoints: endpoints.map((e) => ({
      method: e.method || 'GET',
      path: e.path,
      price: String(e.price),
      asset: e.asset || defaultAsset,
      network: e.network || 'base',
      description: e.description || '',
    })),
    generatedAt: new Date().toISOString(),
  };
  return function x402Manifest(req, res) {
    res.json(manifest);
  };
}

module.exports = { paidRoute, manifestRoute };
